import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_FILE_KEY_PREFIX,
  SEARCH_FILE_LIMIT,
  SEARCH_RESULT_LIMIT,
  SEARCH_SOURCE_KEY,
} from '@/lib/config';
import {
  folderDocumentUrl,
  folderPermission,
  readDirectory,
  readFileText,
  recallFolder,
} from '@/lib/folder';
import type { Heading } from '@/lib/markdown';
import type { DetailedMatch, SearchOptions } from '@/lib/search';
import { isFailure, searchClient } from '@/lib/search-client';

import type { FolderStatus, OpenedDocument } from './FolderBrowser';

import './search-panel.css';

/** Registry key for the range this panel paints on a result being opened. */
const PAINT_HIT = 'mdv-search-jump';

const CAN_PAINT =
  typeof CSS !== 'undefined' &&
  typeof Highlight === 'function' &&
  CSS.highlights !== undefined;

/** How long a result stays lit after being jumped to. */
const FLASH_MS = 2200;

/** Where a revealed match is parked, as a fraction of the viewport height. */
const REVEAL_RATIO = 0.3;

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

interface FileResult {
  /** The worker's cache key. `SEARCH_SOURCE_KEY` is the document on screen. */
  key: string;
  label: string;
  matches: DetailedMatch[];
  /** Hit the per-file cap; there are more matches in this file. */
  truncated: boolean;
  /** The scan was abandoned on time. Only a regex can cause this. */
  timedOut: boolean;
  /** Present for a file in the folder, absent for the document on screen. */
  handle?: FileSystemFileHandle;
  path?: string;
}

/** One line of the flattened, keyboard-navigable list. */
interface Row {
  key: string;
  file: number;
  /** Undefined on a file header. */
  match?: number;
}

/* -------------------------------------------------------------------------- */
/* Walking a folder                                                            */
/* -------------------------------------------------------------------------- */

interface FolderFile {
  path: string;
  handle: FileSystemFileHandle;
}

/**
 * Every markdown file under a directory handle, depth first.
 *
 * `readDirectory` already applies the rules that matter — `node_modules`, `.git`
 * and every dotted name are skipped, and only `MARKDOWN_EXTENSIONS` come back —
 * so this is only the recursion and the abort check. A generator rather than an
 * array because a search should show its first result before the walk has
 * finished, and because abandoning it halfway must cost nothing.
 */
async function* walkFolder(
  root: FileSystemDirectoryHandle,
  signal: AbortSignal,
  path = '',
): AsyncGenerator<FolderFile> {
  let listing;
  try {
    listing = await readDirectory(root, path);
  } catch {
    // An unreadable directory is a fact about that directory, not a reason to
    // abandon the search.
    return;
  }

  for (const entry of listing.entries) {
    if (signal.aborted) return;

    if (entry.kind === 'file') {
      yield { path: entry.path, handle: entry.handle as FileSystemFileHandle };
      continue;
    }

    yield* walkFolder(entry.handle as FileSystemDirectoryHandle, signal, entry.path);
  }
}

/* -------------------------------------------------------------------------- */
/* Getting back to the document                                                */
/* -------------------------------------------------------------------------- */

/**
 * The rendered heading a result sits under.
 *
 * The panel searches the markdown *source*, so what it has is a breadcrumb of
 * heading text and not an element. Matching back by text is deliberately loose
 * and deliberately outermost-last: the deepest heading is tried first, and each
 * failure falls back one level, so a result under an `h5` — which never reaches
 * `TOC_LEVELS` and so has no entry in `headings` at all — still lands in the
 * right chapter rather than nowhere.
 */
function headingElementFor(headings: Heading[], breadcrumb: string[]): HTMLElement | null {
  for (let index = breadcrumb.length - 1; index >= 0; index -= 1) {
    const wanted = breadcrumb[index];
    const heading = headings.find((entry) => entry.text === wanted);
    const element = heading ? document.getElementById(heading.id) : null;
    if (element) return element;
  }
  return null;
}

/**
 * The first occurrence of `needle` in the rendered body at or after `from`.
 *
 * Within a single text node only. A match that straddles one — the `word` in
 * `**wo**rd` — is given up on rather than reassembled, because the reassembly
 * needs the very offset index `components/Search.tsx` builds for quick find, and
 * building a second one here on every click would be paying the document's whole
 * cost to place a single highlight. The section scroll below is the answer when
 * this returns null, and it is the answer the reader would have got from a table
 * of contents anyway.
 */
function findTextAfter(
  body: HTMLElement,
  from: Node | null,
  needle: string,
  caseSensitive: boolean,
): Range | null {
  if (needle.length === 0) return null;

  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const wanted = caseSensitive ? needle : needle.toLowerCase();
  let reached = from === null;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;

    if (!reached) {
      // `from` is an element; its own descendants come after it in this walk.
      if (from && (from === node || from.contains(node))) reached = true;
      else if (from && from.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        reached = true;
      } else continue;
    }

    const haystack = caseSensitive ? node.data : node.data.toLowerCase();
    const at = haystack.indexOf(wanted);
    if (at < 0) continue;

    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    return range;
  }

  return null;
}

function scrollTo(rect: DOMRect) {
  window.scrollTo({
    top: Math.max(0, rect.top + window.scrollY - window.innerHeight * REVEAL_RATIO),
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  });
}

function unpaint() {
  if (CAN_PAINT) CSS.highlights.delete(PAINT_HIT);
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                   */
/* -------------------------------------------------------------------------- */

export interface SearchPanelProps {
  /** The markdown on screen. What the panel searches, and where lines come from. */
  source: string;
  /** The rendered outline, used only to get from a result back to the document. */
  headings: Heading[];
  /** Whether this panel is the one showing. Nothing runs while it is not. */
  visible: boolean;
  /** Whether the Files tab has a folder open, which is what enables cross-file. */
  folderStatus: FolderStatus;
  /** Bumped when the shortcut opened this tab, which is the only time focus moves. */
  focusToken: number;
  /** Escape: hand the sidebar back to whichever tab was showing before. */
  onClose: () => void;
  /** Opening a result that lives in another file swaps the rendered document. */
  onOpenDocument: (document: OpenedDocument) => void;
}

/**
 * Full-document search: every match in the file, in order, with the heading it
 * falls under and the line it is on — and, when a folder is open, the same
 * across every markdown file in it.
 *
 * This is not the other search. Quick find (`components/Search.tsx`) answers
 * "take me to the next one" against what is rendered on screen; this answers
 * "where does this appear", which is a different question and wants a different
 * shape of answer — a list you read rather than a cursor you advance.
 *
 * It searches the markdown **source**, not the DOM, and that is the load-bearing
 * decision here. A line number is a fact about a file: it cannot be recovered
 * from a rendered tree, it is what makes a result useful next to an editor, and
 * it is the only text that exists at all for a file in the folder that has never
 * been opened. The cost is that getting from a result back to the document on
 * screen is a search rather than a lookup — see `findTextAfter`.
 *
 * Everything below the debounce is asynchronous and cancellable. Matching runs
 * in the worker (`lib/search-client.ts`), files stream in as they are read, and
 * a superseded query aborts its controller — which stops the folder walk mid-way
 * rather than letting a thousand file reads finish for a query nobody is waiting
 * on any more.
 */
export function SearchPanel({
  source,
  headings,
  visible,
  folderStatus,
  focusToken,
  onClose,
  onOpenDocument,
}: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [settled, setSettled] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [allFiles, setAllFiles] = useState(false);

  const [results, setResults] = useState<FileResult[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capped, setCapped] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Which run the answers arriving are allowed to be from. */
  const runRef = useRef(0);
  const flashRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const options: SearchOptions = useMemo(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  /* --- the folder --------------------------------------------------------- */

  // Read straight out of the handle store rather than from the Files tab. Both
  // are looking at the same IndexedDB record, and asking for it here means this
  // panel keeps working whether or not the Files panel has ever been rendered.
  // `folderStatus` is the change signal, not the source of truth.
  useEffect(() => {
    let alive = true;

    void (async () => {
      const handle = await recallFolder();
      if (!alive) return;
      // Never `requestPermission`: that needs a user gesture, and an effect
      // firing a permission prompt at somebody who opened a sidebar tab is the
      // behaviour every reader hates.
      const granted = handle ? await folderPermission(handle) : 'denied';
      if (alive) setRoot(granted === 'granted' ? handle : null);
    })();

    return () => {
      alive = false;
    };
  }, [folderStatus]);

  // A folder being closed must not leave the checkbox ticked and the scope
  // silently reduced to one file.
  useEffect(() => {
    if (!root) setAllFiles(false);
  }, [root]);

  /* --- query pipeline ----------------------------------------------------- */

  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!visible) return;

    runRef.current += 1;
    const runId = runRef.current;

    if (settled.length === 0) {
      setResults([]);
      setError(null);
      setCapped(false);
      setBusy(false);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const client = searchClient();

    setBusy(true);
    setError(null);
    setCapped(false);

    void (async () => {
      const collected: FileResult[] = [];
      let total = 0;
      let flushed = false;

      /** Renders what has been found so far. Streaming is the point. */
      const flush = () => {
        if (runId === runRef.current) setResults([...collected]);
        flushed = true;
      };

      const take = (
        answer: Awaited<ReturnType<typeof client.search>>,
        base: Omit<FileResult, 'matches' | 'truncated' | 'timedOut'>,
      ): boolean => {
        if (isFailure(answer)) {
          // A timeout is the wedged-worker case: the pattern was catastrophic
          // enough that the thread had to be killed. Saying so is better than a
          // silently short list.
          if (answer.reason === 'timeout') setError('That pattern took too long to run.');
          return false;
        }

        if (answer.kind === 'invalid') {
          setError(answer.error);
          return false;
        }

        if (answer.matches.length > 0) {
          collected.push({
            ...base,
            matches: answer.matches as DetailedMatch[],
            truncated: answer.truncated,
            timedOut: answer.timedOut,
          });
          total += answer.matches.length;
          flush();
        } else if (!flushed) {
          // The first answer of a run always renders, even when it is empty: the
          // flush is what clears the *previous* query's rows, and a query going
          // from five results to none would otherwise leave all five on screen.
          // After that, a file with nothing in it is not worth a render.
          flush();
        }

        return true;
      };

      /* The document on screen, always first and always present. */
      client.put(SEARCH_SOURCE_KEY, source);
      const own = await client.search({
        runId,
        key: SEARCH_SOURCE_KEY,
        query: settled,
        options,
        detail: 'lines',
        limit: SEARCH_RESULT_LIMIT,
        signal,
      });

      if (runId !== runRef.current) return;
      if (!take(own, { key: SEARCH_SOURCE_KEY, label: 'This document' })) {
        setResults([]);
        setBusy(false);
        return;
      }

      /* Then the folder, one file at a time. */
      if (allFiles && root) {
        let files = 0;

        for await (const file of walkFolder(root, signal)) {
          if (signal.aborted || runId !== runRef.current) return;

          files += 1;
          if (files > SEARCH_FILE_LIMIT || total >= SEARCH_RESULT_LIMIT) {
            setCapped(true);
            break;
          }

          let text: string;
          try {
            text = await readFileText(file.handle);
          } catch {
            // Unreadable now, listed a moment ago. Skipping it is the only
            // honest answer and it is not worth a row of its own.
            continue;
          }

          const key = SEARCH_FILE_KEY_PREFIX + file.path;
          const answer = await client.search({
            runId,
            key,
            text,
            query: settled,
            options,
            detail: 'lines',
            limit: Math.max(1, SEARCH_RESULT_LIMIT - total),
            signal,
          });

          // The engine caches by key so a repeated query is cheap; a folder-wide
          // sweep is the case where that turns into holding the whole folder in
          // memory, so each file is released as soon as it has been searched.
          client.drop(key);

          if (runId !== runRef.current) return;
          if (!take(answer, { key, label: file.path, handle: file.handle, path: file.path })) {
            break;
          }
        }
      }

      if (runId === runRef.current) setBusy(false);
    })();

    return () => controller.abort();
  }, [visible, settled, options, allFiles, root, source]);

  /* --- focus and announcements -------------------------------------------- */

  // Only on the shortcut. Focusing whenever the panel became visible would take
  // focus off the tab strip every time somebody arrowed across it, and would
  // steal it outright on a page that simply restored this tab from last time.
  useEffect(() => {
    if (focusToken === 0 || !visible) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken, visible]);

  const matchCount = results.reduce((sum, file) => sum + file.matches.length, 0);

  // Late and polite, for the reason quick find gives: a count that is still
  // moving is an interruption rather than information.
  useEffect(() => {
    if (!visible || settled.length === 0) {
      setAnnouncement('');
      return;
    }

    const timer = setTimeout(() => {
      if (error) setAnnouncement(error);
      else if (matchCount === 0) setAnnouncement(`No results for ${settled}`);
      else {
        setAnnouncement(
          `${matchCount} result${matchCount === 1 ? '' : 's'} in ` +
            `${results.length} file${results.length === 1 ? '' : 's'}`,
        );
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [visible, settled, matchCount, results.length, error]);

  // The painted range belongs to this panel; nothing else may be left holding it.
  useEffect(() => unpaint, []);
  useEffect(() => {
    if (!visible) unpaint();
  }, [visible]);

  /* --- opening a result --------------------------------------------------- */

  const openMatch = useCallback(
    (file: FileResult, match: DetailedMatch) => {
      if (file.key !== SEARCH_SOURCE_KEY) {
        // Another file: render it, and let the search re-run against the new
        // source. Jumping to the line as well would mean scrolling a document
        // that has not been laid out yet.
        if (!file.handle || !root || file.path === undefined) return;
        const handle = file.handle;
        const path = file.path;

        void readFileText(handle)
          .then((text) =>
            onOpenDocument({
              url: folderDocumentUrl(root.name, path),
              name: path.split('/').pop() ?? path,
              path,
              source: text,
            }),
          )
          .catch(() => setError(`${path} could not be read.`));
        return;
      }

      const body = document.querySelector<HTMLElement>('main.mdv-body');
      if (!body) return;

      const anchor = headingElementFor(headings, match.breadcrumb);
      const range = findTextAfter(body, anchor, match.hit, caseSensitive);

      clearTimeout(flashRef.current);

      if (range && CAN_PAINT) {
        CSS.highlights.set(PAINT_HIT, new Highlight(range));
        flashRef.current = setTimeout(unpaint, FLASH_MS);
      }

      const rect = range?.getBoundingClientRect() ?? anchor?.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) scrollTo(rect);
      else anchor?.scrollIntoView({ block: 'center' });
    },
    [headings, caseSensitive, root, onOpenDocument],
  );

  /* --- the flattened list ------------------------------------------------- */

  const rows = useMemo(() => {
    const out: Row[] = [];
    results.forEach((file, index) => {
      out.push({ key: `f${index}`, file: index });
      if (collapsed.has(file.key)) return;
      file.matches.forEach((_, position) => {
        out.push({ key: `f${index}:m${position}`, file: index, match: position });
      });
    });
    return out;
  }, [results, collapsed]);

  const focusRow = useCallback((key: string) => {
    setFocusKey(key);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-mdv-row="${CSS.escape(key)}"]`)
      ?.focus();
  }, []);

  const toggleFile = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const activate = useCallback(
    (row: Row) => {
      const file = results[row.file];
      if (!file) return;
      if (row.match === undefined) toggleFile(file.key);
      else openMatch(file, file.matches[row.match]);
    },
    [results, toggleFile, openMatch],
  );

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (rows.length === 0) return;

    // Where the keystroke landed, not where state last recorded it: a keydown in
    // the same task as the focus before it would be measured from the old row.
    const from =
      (event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-mdv-row]')?.dataset.mdvRow
        : undefined) ?? focusKey;

    const at = Math.max(
      0,
      rows.findIndex((row) => row.key === from),
    );
    const row = rows[at];

    const step = (to: number) => {
      event.preventDefault();
      focusRow(rows[Math.min(rows.length - 1, Math.max(0, to))].key);
    };

    switch (event.key) {
      case 'ArrowDown':
        step(at + 1);
        return;
      case 'ArrowUp':
        // Off the top of the list is back into the field, which is where the
        // reader came from and where the query still is.
        if (at === 0) {
          event.preventDefault();
          inputRef.current?.focus();
          return;
        }
        step(at - 1);
        return;
      case 'Home':
        step(0);
        return;
      case 'End':
        step(rows.length - 1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.match === undefined) setCollapsed((c) => new Set(c).add(results[row.file].key));
        else focusRow(`f${row.file}`);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (row.match === undefined) {
          setCollapsed((current) => {
            const next = new Set(current);
            next.delete(results[row.file].key);
            return next;
          });
        }
        return;
      case 'Enter':
        event.preventDefault();
        activate(row);
        return;
      default:
    }
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown' && rows.length > 0) {
      event.preventDefault();
      focusRow(rows[0].key);
      return;
    }

    // Enter from the field goes to the first result, which is what somebody who
    // typed a query and pressed Enter meant by it.
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = rows.find((entry) => entry.match !== undefined);
      if (first) activate(first);
    }
  };

  /* --- render ------------------------------------------------------------- */

  const truncatedFiles = results.filter((file) => file.truncated).length;
  const timedOut = results.some((file) => file.timedOut);

  const summary = (() => {
    if (settled.length === 0) return 'Type to search this document.';
    if (error) return null;
    if (matchCount === 0) return busy ? 'Searching…' : 'No results.';

    const files = results.length;
    return (
      `${matchCount.toLocaleString()} result${matchCount === 1 ? '' : 's'}` +
      (allFiles ? ` in ${files} file${files === 1 ? '' : 's'}` : '') +
      (busy ? ' so far…' : '')
    );
  })();

  return (
    <div className="mdv-find" role="search" aria-label="Search the document">
      <div className="mdv-find-head">
        <input
          ref={inputRef}
          className="mdv-find-field"
          type="text"
          value={query}
          placeholder="Search"
          aria-label={allFiles ? 'Search all files in folder' : 'Search this document'}
          aria-invalid={error !== null}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onInputKeyDown}
        />

        <div className="mdv-find-options" role="group" aria-label="Search options">
          <Toggle
            label="Match case"
            glyph="Aa"
            on={caseSensitive}
            onChange={() => setCaseSensitive((value) => !value)}
          />
          <Toggle
            label="Whole word"
            glyph="ab|"
            on={wholeWord}
            onChange={() => setWholeWord((value) => !value)}
          />
          <Toggle
            label="Regular expression"
            glyph=".*"
            on={regex}
            onChange={() => setRegex((value) => !value)}
          />
        </div>
      </div>

      <label
        className="mdv-find-scope"
        title={
          root
            ? `Search every markdown file in ${root.name}`
            : 'Open a folder in the Files tab to search across files.'
        }
      >
        <input
          type="checkbox"
          checked={allFiles}
          disabled={root === null}
          onChange={(event) => setAllFiles(event.target.checked)}
        />
        <span>Search all files in folder</span>
      </label>

      {error ? (
        <p className="mdv-find-error" role="alert">
          {error}
        </p>
      ) : null}

      {summary ? <p className="mdv-find-summary">{summary}</p> : null}

      <div
        className="mdv-side-scroll mdv-find-results"
        ref={listRef}
        role="tree"
        aria-label="Search results"
        aria-busy={busy}
        onKeyDown={onListKeyDown}
      >
        {results.map((file, fileIndex) => {
          const open = !collapsed.has(file.key);
          const headerKey = `f${fileIndex}`;

          return (
            <div className="mdv-find-group" key={file.key} role="none">
              <button
                type="button"
                className="mdv-find-file"
                data-mdv-row={headerKey}
                role="treeitem"
                aria-level={1}
                aria-expanded={open}
                aria-posinset={fileIndex + 1}
                aria-setsize={results.length}
                tabIndex={focusKey === headerKey ? 0 : -1}
                title={file.label}
                onFocus={() => setFocusKey(headerKey)}
                onClick={() => toggleFile(file.key)}
              >
                <Caret open={open} />
                <span className="mdv-find-file-name">{file.label}</span>
                <span className="mdv-find-file-count">
                  {file.matches.length}
                  {file.truncated ? '+' : ''}
                </span>
              </button>

              {open ? (
                <div className="mdv-find-hits" role="group">
                  {file.matches.map((match, position) => {
                    const rowKey = `f${fileIndex}:m${position}`;
                    const trail = match.breadcrumb.join(' › ');

                    return (
                      <button
                        key={rowKey}
                        type="button"
                        className="mdv-find-hit"
                        data-mdv-row={rowKey}
                        role="treeitem"
                        aria-level={2}
                        aria-posinset={position + 1}
                        aria-setsize={file.matches.length}
                        tabIndex={focusKey === rowKey ? 0 : -1}
                        aria-label={
                          `Line ${match.line + 1}` +
                          (trail ? `, under ${trail}` : '') +
                          `: ${match.before}${match.hit}${match.after}`
                        }
                        onFocus={() => setFocusKey(rowKey)}
                        onClick={() => openMatch(file, match)}
                      >
                        <span className="mdv-find-meta" aria-hidden="true">
                          {trail ? <span className="mdv-find-trail">{trail}</span> : null}
                          <span className="mdv-find-line">{match.line + 1}</span>
                        </span>
                        <span className="mdv-find-text" aria-hidden="true">
                          {match.before}
                          <mark className="mdv-find-mark">{match.hit}</mark>
                          {match.after}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        {capped ? (
          <p className="mdv-find-note">
            Showing the first {SEARCH_RESULT_LIMIT.toLocaleString()} results. Narrow
            the query to see the rest.
          </p>
        ) : null}

        {truncatedFiles > 0 && !capped ? (
          <p className="mdv-find-note">
            {truncatedFiles === 1
              ? 'One file had more matches than are listed.'
              : `${truncatedFiles} files had more matches than are listed.`}
          </p>
        ) : null}

        {timedOut ? (
          <p className="mdv-find-note">
            That pattern was too slow to finish; some text was not searched.
          </p>
        ) : null}
      </div>

      <div className="mdv-find-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function Toggle({
  label,
  glyph,
  on,
  onChange,
}: {
  label: string;
  glyph: string;
  on: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      className="mdv-find-toggle"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onChange}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      className="mdv-find-caret"
      data-open={open ? '' : undefined}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
