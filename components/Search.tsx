import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { SEARCH_MATCH_LIMIT, SHORTCUTS } from '@/lib/config';
import type { Heading } from '@/lib/markdown';

import './search.css';

/** Keystroke settling time before a query is run. One keypress, not one search. */
const DEBOUNCE_MS = 110;

/** How long the count has to hold still before it is announced. */
const ANNOUNCE_MS = 550;

/**
 * Results rendered at once. The match list runs to SEARCH_MATCH_LIMIT, but a
 * couple of thousand list items is a rebuild the panel can be felt typing
 * through, so the list shows one page at a time and the page follows the
 * current match — every match stays reachable, and the DOM stays small.
 */
const RESULT_PAGE = 200;

/** Context kept around a match in its result snippet. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 60;

/** Where a revealed match is parked, as a fraction of the viewport height. */
const REVEAL_RATIO = 0.35;

/** Margin inside which a match counts as already on screen and is left alone. */
const COMFORT_PX = 96;

/** Registry keys for the two painted highlights. Current sits on top of all. */
const PAINT_ALL = 'mdv-search';
const PAINT_CURRENT = 'mdv-search-current';

/**
 * Subtrees that are in the document body but are not the document.
 *
 * `Document.tsx` grafts a copy button onto every code block and an anchor onto
 * every heading, so "Copy" and "Copied" are real text nodes sitting in the body
 * — without this, searching for `copy` would hit every code block in the file.
 * The KaTeX add-on emits its MathML twin of every formula alongside the visible
 * markup, which would count every equation twice.
 */
const SKIP_SUBTREE =
  'script, style, template, svg, .mdv-copy, .mdv-anchor, .katex-mathml, [data-mdv-chrome]';

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/** Painting ranges instead of marking them up needs the Custom Highlight API. */
const CAN_PAINT =
  typeof CSS !== 'undefined' &&
  typeof Highlight === 'function' &&
  CSS.highlights !== undefined;

/* -------------------------------------------------------------------------- */
/* The document as a single string                                             */
/* -------------------------------------------------------------------------- */

interface Section {
  /** Offset into `DocIndex.text` where this section's content begins. */
  start: number;
  /** Null for whatever precedes the first heading. */
  heading: Heading | null;
}

interface DocIndex {
  body: HTMLElement;
  /** Identity of the outline this was built against; a new parse invalidates it. */
  headings: Heading[];
  /** Every searchable text node, concatenated. */
  text: string;
  /** `text` lowercased, offset-for-offset. */
  lower: string;
  nodes: Text[];
  /** `starts[i]` is where `nodes[i]` begins in `text`. Ascending, so bisectable. */
  starts: number[];
  sections: Section[];
}

interface Match {
  start: number;
  end: number;
  /** Index into `DocIndex.sections`. */
  section: number;
  before: string;
  hit: string;
  after: string;
}

interface Result {
  matches: Match[];
  /** True when the query has more matches than SEARCH_MATCH_LIMIT allows. */
  truncated: boolean;
}

const NO_RESULT: Result = { matches: [], truncated: false };

/**
 * One TreeWalker pass over the whole document.
 *
 * This is the expensive thing search does, and it happens once per document
 * rather than once per keystroke: everything after this point is `indexOf` over
 * a string. Both element and text nodes are visited, because the elements are
 * what carry the section boundaries — a heading pushes a boundary at the offset
 * its own text is about to land on, so the section a match belongs to is a
 * pointer walk rather than a DOM lookup.
 */
function buildIndex(body: HTMLElement, headings: Heading[]): DocIndex {
  const byId = new Map(headings.map((heading) => [heading.id, heading]));
  const nodes: Text[] = [];
  const starts: number[] = [];
  const parts: string[] = [];
  const sections: Section[] = [{ start: 0, heading: null }];
  let length = 0;

  const walker = document.createTreeWalker(
    body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return (node as Text).data.length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
        // REJECT on an element skips its entire subtree, which is the whole
        // point: one `matches` call per element keeps every copy button and
        // every MathML twin out of the index for the cost of a selector test.
        return (node as Element).matches(SKIP_SUBTREE)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  while (walker.nextNode()) {
    const node = walker.currentNode;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const heading = element.id ? byId.get(element.id) : undefined;
      if (heading && HEADING_TAGS.has(element.tagName)) {
        sections.push({ start: length, heading });
      }
      continue;
    }

    const text = node as Text;
    nodes.push(text);
    starts.push(length);
    parts.push(text.data);
    length += text.data.length;
  }

  const text = parts.join('');
  return { body, headings, text, lower: toLower(text), nodes, starts, sections };
}

/**
 * Lowercase without changing the length.
 *
 * A handful of code points grow when lowercased (`İ` becomes two characters),
 * and a single one of them anywhere in a README would slide every offset after
 * it off its text node — matches would then be painted in the wrong place
 * rather than merely be missed. The cheap whole-string form is checked and only
 * falls back to the per-character pass when it actually happened.
 */
function toLower(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;

  let out = '';
  for (const character of text) {
    const folded = character.toLowerCase();
    out += folded.length === character.length ? folded : character;
  }
  return out;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function isWordEdge(haystack: string, start: number, end: number): boolean {
  const before = start > 0 ? haystack[start - 1] : '';
  const after = end < haystack.length ? haystack[end] : '';
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after);
}

/** Whitespace collapsed to single spaces, so a snippet is always one line. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Every match, in document order, capped at SEARCH_MATCH_LIMIT.
 *
 * Plain `indexOf` over the cached string — no regex, and nothing that touches
 * the DOM. Sections are assigned by advancing a pointer through the boundary
 * list, which works because both lists are already in document order.
 */
function findMatches(
  index: DocIndex,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
): Result {
  const haystack = caseSensitive ? index.text : index.lower;
  const needle = caseSensitive ? query : toLower(query);
  if (needle.length === 0) return NO_RESULT;

  const matches: Match[] = [];
  let section = 0;
  let from = 0;

  while (matches.length < SEARCH_MATCH_LIMIT) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return { matches, truncated: false };

    const end = at + needle.length;

    if (wholeWord && !isWordEdge(haystack, at, end)) {
      // One character on, not past the whole candidate: `bookkeeper` contains a
      // later `keep` that a longer skip would step over.
      from = at + 1;
      continue;
    }

    while (
      section + 1 < index.sections.length &&
      index.sections[section + 1].start <= at
    ) {
      section += 1;
    }

    matches.push({
      start: at,
      end,
      section,
      // Trimmed at the outer edges only: the block boundaries a snippet spans
      // are runs of newlines, and leaving them as spaces indents every result.
      before: tidy(index.text.slice(Math.max(0, at - SNIPPET_BEFORE), at)).trimStart(),
      hit: tidy(index.text.slice(at, end)),
      after: tidy(index.text.slice(end, end + SNIPPET_AFTER)).trimEnd(),
    });

    // Non-overlapping, which is what a reader counting occurrences expects.
    from = end;
  }

  return { matches, truncated: haystack.indexOf(needle, from) >= 0 };
}

/* -------------------------------------------------------------------------- */
/* Offsets back into the DOM                                                   */
/* -------------------------------------------------------------------------- */

/** The text node an offset falls in, by bisection over `starts`. */
function locate(index: DocIndex, offset: number): { node: Text; offset: number } {
  let low = 0;
  let high = index.starts.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (index.starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }

  return { node: index.nodes[low], offset: offset - index.starts[low] };
}

/**
 * A live Range over a match. Matches routinely span text nodes — `**bold** word`
 * is three of them — so start and end are resolved independently.
 */
function rangeFor(index: DocIndex, match: Match): Range | null {
  if (index.nodes.length === 0) return null;

  try {
    const from = locate(index, match.start);
    const to = locate(index, match.end);

    const range = document.createRange();
    range.setStart(from.node, Math.min(from.offset, from.node.data.length));
    range.setEnd(to.node, Math.min(to.offset, to.node.data.length));
    return range;
  } catch {
    // The document moved under a cached index. The mutation observer will have
    // scheduled a rebuild; skipping one paint is the right cost.
    return null;
  }
}

/** Opens any collapsed `<details>` around a node, the way find-in-page does. */
function revealAncestors(node: Node) {
  let element = node.parentElement;
  while (element) {
    if (element instanceof HTMLDetailsElement && !element.open) element.open = true;
    element = element.parentElement;
  }
}

/** A match's box, or its parent's if the range itself measures to nothing. */
function rectOf(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) return rect;

  const host = range.startContainer.parentElement;
  const fallback = host?.getBoundingClientRect();
  return fallback && (fallback.width > 0 || fallback.height > 0) ? fallback : null;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Brings a match on screen, leaving it alone if it already is. */
function reveal(index: DocIndex, match: Match | undefined, smooth: boolean) {
  if (!match) return;

  const range = rangeFor(index, match);
  if (!range) return;

  // Before measuring, not after failing to: Chrome keeps a closed <details>'
  // content in the layout tree, so a match inside one reports a perfectly
  // ordinary box that simply cannot be seen. There is nothing in the geometry
  // to detect that from — the only reliable signal is the ancestor itself.
  revealAncestors(range.startContainer);

  const rect = rectOf(range);
  if (!rect) return;

  if (rect.top >= COMFORT_PX && rect.bottom <= window.innerHeight - COMFORT_PX) {
    return;
  }

  window.scrollTo({
    top: Math.max(0, rect.top + window.scrollY - window.innerHeight * REVEAL_RATIO),
    behavior: smooth && !reducedMotion() ? 'smooth' : 'auto',
  });
}

/**
 * The match the reader is already looking at.
 *
 * Retyping a query should not throw the document back to the top, so the new
 * current match is the first one at or below the current scroll position.
 * Matches are in document order, so that is a bisection — a dozen rect reads
 * rather than one per match, which matters when there are two thousand of them.
 */
function matchNearViewport(index: DocIndex, matches: Match[]): number {
  if (matches.length === 0) return 0;

  const anchor = window.scrollY;
  let low = 0;
  let high = matches.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = rangeFor(index, matches[mid]);
    const rect = range ? rectOf(range) : null;
    const top = rect ? rect.top + window.scrollY : anchor;

    if (top >= anchor) {
      best = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  // Everything is above the fold — the nearest match is then the last one, not
  // a jump back to the first.
  return best < 0 ? matches.length - 1 : best;
}

/* -------------------------------------------------------------------------- */
/* Painting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Matches are painted with the CSS Custom Highlight API, never marked up.
 *
 * The body is injected HTML that `Document.tsx` has already grafted copy
 * buttons and heading anchors onto, and that the add-ons replace nodes inside.
 * Wrapping matches in `<mark>` would mean editing that tree on every keystroke:
 * it splits text nodes, invalidates this index, feeds the mutation observer its
 * own edits, and any bug in unwinding it corrupts the document permanently.
 * Ranges paint over the text and own nothing — closing the panel is a `delete`,
 * and the document is byte-for-byte what it was.
 */
function paint(index: DocIndex | null, matches: Match[], current: number) {
  if (!index) return;

  // Without the API there is still no version of this that rewrites the
  // document: the current match goes into the document's own selection, which
  // paints through ::selection, changes no node, and undoes by being dropped.
  // Every other match keeps its place in the result list and its count.
  if (!CAN_PAINT) {
    const range = matches[current] ? rangeFor(index, matches[current]) : null;
    const selection = document.getSelection();
    if (!selection) return;

    selection.removeAllRanges();
    if (range) selection.addRange(range);
    return;
  }

  const others: Range[] = [];
  let active: Range | null = null;

  matches.forEach((match, position) => {
    const range = rangeFor(index, match);
    if (!range) return;
    if (position === current) active = range;
    else others.push(range);
  });

  CSS.highlights.set(PAINT_ALL, new Highlight(...others));
  CSS.highlights.set(PAINT_CURRENT, new Highlight(...(active ? [active] : [])));
}

function unpaint() {
  if (!CAN_PAINT) {
    document.getSelection()?.removeAllRanges();
    return;
  }

  CSS.highlights.delete(PAINT_ALL);
  CSS.highlights.delete(PAINT_CURRENT);
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * In-document search: a query field, a live count, next/previous, and a result
 * list grouped by the section each match falls under.
 *
 * It takes over ctrl/cmd+F deliberately, which is only defensible because it
 * does more than the bar it replaces — the section grouping is the reason it
 * exists. Escape always closes it and hands focus back.
 *
 * Nothing here writes to the document: the index is read once per document with
 * a TreeWalker and searched as a string, and matches are painted as ranges. The
 * only DOM this component owns is its own panel.
 */
export function Search({ headings }: { headings: Heading[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settled, setSettled] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [result, setResult] = useState<Result>(NO_RESULT);
  const [current, setCurrent] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  // Bumped when the document changes under a cached index.
  const [revision, setRevision] = useState(0);

  const indexRef = useRef<DocIndex | null>(null);
  /** `current`, readable between renders. See `step`. */
  const currentRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // The window listener is bound once; this is how it reads current state.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  const listId = useId();
  const optionId = (position: number) => `${listId}-${position}`;

  const total = result.matches.length;

  /** The cached index, rebuilt only when the document or the outline changed. */
  const getIndex = useCallback((): DocIndex | null => {
    const body = document.querySelector<HTMLElement>('main.mdv-body');
    if (!body) return null;

    const cached = indexRef.current;
    if (cached && cached.body === body && cached.headings === headings) {
      return cached;
    }

    const built = buildIndex(body, headings);
    indexRef.current = built;
    return built;
  }, [headings]);

  /* --- opening and closing ------------------------------------------------ */

  const openPanel = useCallback(() => {
    if (!openRef.current) {
      const active = document.activeElement;
      restoreRef.current = active instanceof HTMLElement ? active : null;
      setOpen(true);
      return;
    }

    // Already open: the shortcut means "start a new search", so the standing
    // query is selected rather than the panel being toggled shut under a reader
    // who pressed the key out of habit.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const closePanel = useCallback(() => setOpen(false), []);

  // Focus in on open, and back where it came from on close. Both have to happen
  // after the commit — restoring before the panel unmounts would move focus to
  // an element that is about to take it back on the way out.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }

    const restore = restoreRef.current;
    restoreRef.current = null;
    if (restore?.isConnected) restore.focus();
  }, [open]);

  // The walk is the one expensive step, and on a multi-MB document it is the
  // reader's first keystroke that would otherwise pay for it. Opening the panel
  // is the free moment: the index is warmed while they are still reaching for
  // the keyboard, and the query effect below builds it synchronously anyway if
  // they get there first.
  useEffect(() => {
    if (!open || typeof requestIdleCallback !== 'function') return;

    const handle = requestIdleCallback(() => void getIndex());
    return () => cancelIdleCallback(handle);
  }, [open, getIndex]);

  /* --- global keys -------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      // ctrl/cmd+F, from anywhere including a field the reader is typing in:
      // the takeover is only honest if it is unconditional, and a modified F
      // is never part of what somebody is typing.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        openPanel();
        return;
      }

      if (openRef.current && event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }

      // `/` is a bare key, so it belongs to whatever has focus first — in a
      // field it is a character, and stealing it would make the search box
      // impossible to type a path into.
      if (
        event.key === SHORTCUTS.search &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        openPanel();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openPanel, closePanel]);

  /* --- query pipeline ----------------------------------------------------- */

  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;

    if (settled.length === 0) {
      setResult(NO_RESULT);
      setCurrent(0);
      return;
    }

    const index = getIndex();
    if (!index) return;

    const found = findMatches(index, settled, caseSensitive, wholeWord);
    const next = matchNearViewport(index, found.matches);

    setResult(found);
    setCurrent(next);
    currentRef.current = next;
    // Instant while typing: a smooth scroll per keystroke would still be
    // travelling when the next one lands.
    reveal(index, found.matches[next], false);
  }, [open, settled, caseSensitive, wholeWord, revision, getIndex]);

  // Nothing this component does mutates the document, so every callback here is
  // somebody else's edit — a mermaid diagram swapping in, live reload replacing
  // the body — after which the cached offsets are fiction.
  useEffect(() => {
    if (!open) return;

    const body = document.querySelector<HTMLElement>('main.mdv-body');
    if (!body) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      indexRef.current = null;
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((count) => count + 1), 200);
    });

    observer.observe(body, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    paint(indexRef.current, result.matches, current);
    return unpaint;
  }, [open, result, current]);

  // Polite, and late: announcing a count that is still changing turns every
  // keystroke into an interruption. One message once the query has stopped.
  useEffect(() => {
    if (!open) {
      setAnnouncement('');
      return;
    }

    const timer = setTimeout(() => {
      if (settled.length === 0) setAnnouncement('');
      else if (total === 0) setAnnouncement(`No matches for ${settled}`);
      else setAnnouncement(`Match ${current + 1} of ${total}`);
    }, ANNOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, settled, total, current]);

  /* --- navigation --------------------------------------------------------- */

  const goTo = useCallback(
    (position: number) => {
      if (total === 0) return;

      // Wrapping at both ends, so the reader never has to notice which end they
      // are at — the count already tells them.
      const next = ((position % total) + total) % total;
      setCurrent(next);
      currentRef.current = next;

      const index = indexRef.current;
      if (index) reveal(index, result.matches[next], true);
    },
    [result, total],
  );

  // Stepped from the ref rather than from the rendered value: two Enters landing
  // in the same frame would otherwise both be measured from the same start and
  // the second would go nowhere.
  const step = useCallback(
    (delta: number) => goTo(currentRef.current + delta),
    [goTo],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      step(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      step(-1);
      return;
    }

    // Home/End move through matches rather than through the field's own text,
    // which is what a list under a search box is expected to do.
    if (event.key === 'Home' && total > 0) {
      event.preventDefault();
      goTo(0);
      return;
    }

    if (event.key === 'End' && total > 0) {
      event.preventDefault();
      goTo(total - 1);
    }
  };

  /* --- results ------------------------------------------------------------ */

  const page = Math.floor(current / RESULT_PAGE);
  const pageStart = page * RESULT_PAGE;
  const pageEnd = Math.min(pageStart + RESULT_PAGE, total);

  // Consecutive matches under the same heading, within the rendered page. The
  // index is read here rather than held in state because it only ever changes
  // alongside `result`, which is what drives this render in the first place.
  const groups = useMemo(() => {
    const sections = indexRef.current?.sections ?? [];
    const out: { key: string; label: string; items: number[] }[] = [];

    for (let position = pageStart; position < pageEnd; position += 1) {
      const match = result.matches[position];
      if (!match) break;

      const last = out[out.length - 1];
      if (last && last.key === String(match.section)) {
        last.items.push(position);
        continue;
      }

      out.push({
        key: String(match.section),
        label: sections[match.section]?.heading?.text ?? 'Start of document',
        items: [position],
      });
    }

    return out;
  }, [result, pageStart, pageEnd]);

  // Keep the active result in view inside the panel's own scroller. `nearest`
  // so it never scrolls the page — the panel is fixed and already on screen.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector(
      `#${CSS.escape(`${listId}-${current}`)}`,
    );
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, current, result, listId]);

  if (!open) return null;

  const counted =
    total === 0
      ? settled.length > 0
        ? 'No results'
        : ''
      : `${current + 1} of ${total}`;

  return (
    <div className="mdv-search" role="search" data-mdv-chrome>
      <div className="mdv-search-bar">
        <SearchIcon />

        <input
          ref={inputRef}
          className="mdv-search-field"
          type="text"
          role="combobox"
          value={query}
          placeholder="Find in document"
          aria-label="Find in document"
          aria-expanded={total > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            total > 0 && current >= pageStart && current < pageEnd
              ? optionId(current)
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />

        <span className="mdv-search-count" aria-hidden="true">
          {counted}
        </span>

        <div className="mdv-search-actions">
          <button
            type="button"
            className="mdv-search-toggle"
            aria-pressed={caseSensitive}
            aria-label="Match case"
            title="Match case"
            onClick={() => setCaseSensitive((on) => !on)}
          >
            <span aria-hidden="true">Aa</span>
          </button>

          <button
            type="button"
            className="mdv-search-toggle"
            aria-pressed={wholeWord}
            aria-label="Whole word"
            title="Whole word"
            onClick={() => setWholeWord((on) => !on)}
          >
            <span aria-hidden="true">ab|</span>
          </button>

          <button
            type="button"
            className="mdv-search-button"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={total === 0}
            onClick={() => step(-1)}
          >
            <ChevronIcon up />
          </button>

          <button
            type="button"
            className="mdv-search-button"
            aria-label="Next match"
            title="Next match (Enter)"
            disabled={total === 0}
            onClick={() => step(1)}
          >
            <ChevronIcon />
          </button>

          <button
            type="button"
            className="mdv-search-button"
            aria-label="Close search"
            title="Close search (Escape)"
            onClick={closePanel}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {result.truncated ? (
        <p className="mdv-search-note">
          Showing the first {SEARCH_MATCH_LIMIT.toLocaleString()} matches. Try a
          longer query.
        </p>
      ) : null}

      <ul
        ref={listRef}
        id={listId}
        className="mdv-search-results"
        role="listbox"
        aria-label="Matches by section"
      >
        {groups.map((group) => (
          <li key={`${group.key}-${group.items[0]}`} role="group" aria-label={group.label}>
            <p className="mdv-search-section" aria-hidden="true">
              <span className="mdv-search-section-name">{group.label}</span>
              <span className="mdv-search-section-count">{group.items.length}</span>
            </p>

            <ul className="mdv-search-group" role="none">
              {group.items.map((position) => {
                const match = result.matches[position];
                return (
                  <li
                    key={position}
                    id={optionId(position)}
                    className="mdv-search-result"
                    role="option"
                    aria-selected={position === current}
                    aria-label={`${match.before}${match.hit}${match.after}, in ${group.label}`}
                    onClick={() => {
                      goTo(position);
                      inputRef.current?.focus();
                    }}
                  >
                    <span className="mdv-search-context" aria-hidden="true">
                      {match.before}
                      <span className="mdv-search-hit">{match.hit}</span>
                      {match.after}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>

      {total > RESULT_PAGE ? (
        <p className="mdv-search-note">
          Results {pageStart + 1}–{pageEnd} of {total}
        </p>
      ) : null}

      <div className="mdv-search-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** Whether a keystroke belongs to whatever the reader is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

function SearchIcon() {
  return (
    <svg
      className="mdv-search-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.4" />
      <path d="m10.3 10.3 3.2 3.2" />
    </svg>
  );
}

function ChevronIcon({ up = false }: { up?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={up ? 'M3.6 10 8 5.6l4.4 4.4' : 'M3.6 6 8 10.4 12.4 6'} />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}
