/**
 * A fold control on every heading, collapsing everything under it up to the
 * next heading of the same or shallower level.
 *
 * The body is injected HTML, so there is no tree to restructure: a fold is an
 * attribute written onto a run of siblings and nothing else, which is what makes
 * it exactly reversible — unfolding removes the attribute and the document is
 * byte-for-byte what it was. This plugin renders nothing at all.
 *
 * Migrated from `components/HeadingFold.tsx`. The two effects it ran are gone:
 * the one keyed on `html` is now `ctx.document.enhance`, which the host batches
 * with every other plugin's pass and re-runs on each render, live reload and raw
 * toggle — so there is no `main.mdv-body` lookup here and no dependency array to
 * get wrong. The one keyed on `enabled` is now `setup` itself, which is the
 * whole point: enabled *is* the plugin.
 *
 * What is not in the DOM is the set of folded ids, which lives in the `setup`
 * closure — a live reload replaces the body wholesale, and the ids are what
 * survive it. Turning the plugin off drops them too: re-enabling it to find
 * sections mysteriously collapsed would be worse than starting fresh.
 *
 * Deliberately not persisted across a reload. A remembered scroll position is a
 * place, and a reader who lands somewhere unexpected can see where they are; a
 * remembered fold is *missing content*, and a document that opens with three
 * sections silently absent is indistinguishable from a broken one.
 */

import { FOLD_LEVELS, VIEWER_ROOT_ID } from '../../lib/config.ts';
import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';

export const HEADING_FOLD_PLUGIN_ID = 'heading-fold';

/**
 * Marks an element the fold is currently hiding. Its value is the id of the
 * heading doing the hiding, which is what lets a link into a folded section
 * find its way back out.
 *
 * An attribute rather than a class because `PURIFY_CONFIG` sets
 * `ALLOW_DATA_ATTR: false` — data-* cannot survive sanitization, so nothing in
 * an untrusted document can arrive pre-folded or forge a fold of its own.
 */
const FOLDED = 'data-mdv-folded';

/** The control, and the marker the stylesheet turns the chevron by. */
const CONTROL = 'mdv-fold';
const STATE = 'data-mdv-fold';

/** Deeper than any real outline; only ever reached by a bug. */
const REVEAL_LIMIT = 32;

const HEADING = /^H([1-6])$/;

const ICON = [
  `<svg class="mdv-fold-icon" viewBox="0 0 16 16" width="12" height="12"`,
  'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"',
  'stroke-linejoin="round" aria-hidden="true" focusable="false">',
  '<path d="M4 6.2 8 10.2l4-4"/></svg>',
].join(' ');

export function createHeadingFoldPlugin(): Plugin {
  return {
    id: HEADING_FOLD_PLUGIN_ID,
    name: 'Collapsible sections',
    description: 'A fold control on every heading, for putting a long document away.',
    apiVersion: PLUGIN_API_VERSION,
    // Replaces the old `headingFold` setting: whether sections fold is now one
    // concept — this plugin's enabled state — rather than a setting and a
    // component that could disagree.
    enabledByDefault: true,

    setup(ctx) {
      /** Ids of the headings the reader has folded. Outlives a live reload. */
      const closed = new Set<string>();
      /** Folds parked while the search panel is open. See `watchSearch` below. */
      const parked = new Set<string>();

      const stop = ctx.document.enhance((body) => {
        // The raw view is a different `<main>` holding one `<pre>`: no headings,
        // nothing to fold, and nothing to leave behind.
        if (ctx.document.isRaw) return;
        return run(body, closed, parked);
      });

      return () => {
        stop();
        closed.clear();
        parked.clear();
      };
    },
  };
}

/**
 * One document's worth of folding: graft the controls on, restore the folds the
 * reader had, and listen. The returned teardown is the pass's exact inverse.
 */
function run(body: HTMLElement, closed: Set<string>, parked: Set<string>): Teardown {
  const ids = attach(body);
  // A live reload can drop a section entirely. Without this the set would grow
  // for as long as the tab stayed open, and an id reappearing hours later would
  // come back folded for no reason the reader could name.
  for (const id of closed) if (!ids.has(id)) closed.delete(id);
  for (const id of parked) if (!ids.has(id)) parked.delete(id);

  apply(body, closed);

  /* --- toggling ----------------------------------------------------------- */

  const toggle = (heading: HTMLElement) => {
    if (closed.has(heading.id)) closed.delete(heading.id);
    else closed.add(heading.id);

    // Anchored on the heading that was clicked: folding a section above the
    // reader's place would otherwise pull the whole document out from under
    // them, and the one thing they are certainly looking at is the control.
    hold(heading, () => apply(body, closed));
  };

  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const origin = event.target;
    if (!(origin instanceof Element)) return;

    const control = origin.closest(`.${CONTROL}`);
    const heading = control?.parentElement;
    if (!heading?.id) return;

    // A real <button>, so Enter and Space arrive here as clicks already and
    // there is no key handling to write.
    event.preventDefault();
    toggle(heading);
  };

  /* --- getting back into a folded section ---------------------------------- */

  /**
   * Opens whatever is hiding `target`, innermost fold last.
   *
   * Repeats because folds nest: opening the h2 that hid a whole chapter can
   * expose an h3 inside it that the reader folded earlier and that hides the
   * target too. Returns whether anything actually moved.
   */
  const reveal = (target: Element | null | undefined): boolean => {
    let opened = false;

    for (let guard = 0; target && guard < REVEAL_LIMIT; guard += 1) {
      const veil = target.closest(`[${FOLDED}]`);
      if (!veil) break;

      const id = veil.getAttribute(FOLDED) ?? '';
      // Nothing left to open, so the attribute is stale — bail rather than spin
      // on it.
      if (!closed.delete(id)) break;

      apply(body, closed);
      opened = true;
    }

    return opened;
  };

  const targetOf = (hash: string): HTMLElement | null => {
    if (hash.length < 2) return null;

    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      id = hash.slice(1);
    }

    const found = document.getElementById(id);
    return found && body.contains(found) ? found : null;
  };

  /**
   * Capture phase, on the document, so this runs before anything else's click
   * handling. The table of contents reads the target's box to compute where to
   * scroll; if the section were still folded it would measure a heading
   * collapsed to nothing and jump to the wrong place.
   */
  const onLinkClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const origin = event.target;
    if (!(origin instanceof Element)) return;

    const link = origin.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.hash.length < 2) return;
    // Same document, not merely same-looking: an external URL that happens to
    // carry a fragment is not ours to act on.
    if (link.href.split('#')[0] !== location.href.split('#')[0]) return;

    reveal(targetOf(link.hash));
  };

  // The address bar, a bookmark, and the Back button all land here instead. The
  // browser has already failed to scroll to a heading it could not see, so the
  // scroll has to be redone once there is something to scroll to.
  const onHashChange = () => {
    const target = targetOf(location.hash);
    if (reveal(target)) target?.scrollIntoView();
  };

  /* --- search -------------------------------------------------------------- */

  /**
   * Folds are suspended while the search panel is open.
   *
   * Search paints its matches as ranges and finds them by measuring: a match
   * inside a folded section measures to nothing, so it is silently skipped, and
   * there is no signal it could send us to ask for the section back. The honest
   * resolution is that searching searches the whole document — the folds step
   * aside while the panel is up and come back when it closes.
   */
  const suspend = () => {
    if (closed.size === 0) return;

    for (const id of closed) parked.add(id);
    closed.clear();
    hold(topOfViewport(body), () => apply(body, closed));
  };

  const resume = () => {
    if (parked.size === 0) return;

    const anchor = topOfViewport(body);
    for (const id of parked) closed.add(id);
    parked.clear();

    hold(anchor, () => {
      apply(body, closed);
      // Whatever the reader searched their way to stays visible: re-folding the
      // section they are standing in would read as the document eating the
      // result they just found.
      reveal(anchor);
    });
  };

  const root = document.getElementById(VIEWER_ROOT_ID) ?? document.body;
  let searchOpen = document.querySelector('.mdv-search') !== null;

  // Not a `MutationObserver` on the *body* — the API replaced those — but on the
  // shell, watching for another feature's surface. There is no route through the
  // plugin API for "the search panel opened": a capability would be it, and
  // quick find is not yet a plugin. Flagged in the report rather than patched.
  const watchSearch = new MutationObserver(() => {
    const open = document.querySelector('.mdv-search') !== null;
    if (open === searchOpen) return;

    searchOpen = open;
    if (open) suspend();
    else resume();
  });

  body.addEventListener('click', onClick);
  document.addEventListener('click', onLinkClick, true);
  window.addEventListener('hashchange', onHashChange);
  // The panel is a child of the shell, but which child is the shell's business
  // and not ours; the subtree flag costs one selector test per batch of DOM
  // changes, and the document is static once it has loaded.
  watchSearch.observe(root, { childList: true, subtree: true });

  // A document opened straight at a fragment, after a live reload that restored
  // the folds around it.
  onHashChange();

  return () => {
    body.removeEventListener('click', onClick);
    document.removeEventListener('click', onLinkClick, true);
    window.removeEventListener('hashchange', onHashChange);
    watchSearch.disconnect();

    // Parked folds would otherwise be lost on a live reload that landed while
    // the search panel was open.
    for (const id of parked) closed.add(id);
    parked.clear();

    detach(body);
  };
}

/* -------------------------------------------------------------------------- */
/* Grafting the controls on                                                    */
/* -------------------------------------------------------------------------- */

/** Built once and cloned per heading, for the reason `code-copy` gives. */
let template: HTMLButtonElement | null = null;

function getTemplate(): HTMLButtonElement {
  if (template) return template;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = CONTROL;
  // Read by the print rule in viewer.css, by Search, which skips the attribute
  // rather than indexing our own controls, and by the exporter, which strips it.
  button.setAttribute('data-mdv-chrome', '');
  button.innerHTML = ICON;

  template = button;
  return template;
}

/** The heading level of an element, or 0 if it is not a foldable heading. */
function levelOf(element: Element): number {
  const match = HEADING.exec(element.tagName);
  const level = match ? Number(match[1]) : 0;
  return FOLD_LEVELS.includes(level) ? level : 0;
}

/**
 * The single pass over a rendered document: a control on every heading that has
 * something under it to fold. Returns the ids it covered.
 *
 * Direct children of the body only. That is where markdown puts its headings,
 * and "everything until the next heading of the same level" is a statement
 * about siblings — a heading nested inside a blockquote or a `<details>` has no
 * such run, so it gets no control rather than a control that does the wrong
 * thing.
 *
 * Nothing is read back off the layout, so the whole pass is one batch of
 * mutations.
 */
function attach(body: HTMLElement): Set<string> {
  const ids = new Set<string>();
  const children = body.children;

  for (let i = 0; i < children.length; i += 1) {
    const heading = children[i] as HTMLElement;
    const level = levelOf(heading);
    // An id is the only stable name a fold has; a heading that came through as
    // raw HTML may not have one.
    if (level === 0 || !heading.id) continue;

    ids.add(heading.id);

    // A heading whose section is empty — the last line of the document, or one
    // immediately followed by a sibling of its own level — has nothing to
    // collapse, and a control that visibly does nothing is worse than none.
    const next = children[i + 1];
    const nextLevel = next ? levelOf(next) : 0;
    if (!next || (nextLevel > 0 && nextLevel <= level)) continue;

    if (heading.firstElementChild?.classList.contains(CONTROL)) continue;

    const control = getTemplate().cloneNode(true) as HTMLButtonElement;
    // `aria-expanded` carries the state, so the label can stay put. Naming the
    // section is what turns a page of identical "Toggle" buttons into something
    // a screen reader can tell apart.
    control.setAttribute('aria-label', `${heading.textContent?.trim() ?? ''} section`);
    // Prepended, never appended: `heading-anchors` decides whether a heading
    // already carries its anchor link by looking at `lastElementChild`, and a
    // control parked there would earn every heading a second anchor.
    heading.prepend(control);

    // No `aria-controls`: what this button governs is a run of siblings with no
    // element of its own to point at, and inventing a wrapper would mean
    // restructuring injected HTML.
  }

  return ids;
}

/** Undoes `attach` and every fold with it — disabling leaves nothing. */
function detach(body: HTMLElement) {
  body.querySelectorAll(`.${CONTROL}`).forEach((control) => control.remove());
  body.querySelectorAll(`[${FOLDED}], [${STATE}]`).forEach((element) => {
    element.removeAttribute(FOLDED);
    element.removeAttribute(STATE);
  });
}

/* -------------------------------------------------------------------------- */
/* Applying the folds                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Rewrites every fold attribute in the body from the set of closed headings.
 *
 * One sweep for the whole state rather than one edit per fold, because the two
 * are not the same thing: a paragraph can sit inside an h3's section *and* the
 * h2's around it, and hiding it twice then showing it once is the bug that
 * makes a fold feature un-reversible. Derived wholesale, it cannot drift.
 *
 * The live `children` collection is read by index rather than copied: only
 * attributes are written, so nothing moves under the loop, and a document with
 * tens of thousands of blocks costs no allocation to sweep.
 */
function apply(body: HTMLElement, closed: Set<string>) {
  const children = body.children;
  /** The level being hidden, and the heading responsible. 0 when visible. */
  let hidingLevel = 0;
  let hidingId = '';

  for (let i = 0; i < children.length; i += 1) {
    const element = children[i] as HTMLElement;
    const level = levelOf(element);

    // A heading of the same or shallower level is where the section ends.
    if (level > 0 && hidingLevel > 0 && level <= hidingLevel) {
      hidingLevel = 0;
      hidingId = '';
    }

    if (hidingLevel > 0) element.setAttribute(FOLDED, hidingId);
    else element.removeAttribute(FOLDED);

    if (level === 0) continue;

    const isClosed = closed.has(element.id);
    element.setAttribute(STATE, isClosed ? 'closed' : 'open');
    element
      .querySelector(`:scope > .${CONTROL}`)
      ?.setAttribute('aria-expanded', String(!isClosed));

    // Already inside a fold, so this heading's own state is not what is hiding
    // anything — the outer one stays in charge until its section ends.
    if (hidingLevel === 0 && isClosed) {
      hidingLevel = level;
      hidingId = element.id;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Keeping the reader's place                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Runs a fold change without moving what the reader is looking at.
 *
 * Folding removes height from the document, and any of it that was *above* the
 * viewport drags the page up by exactly that much. Measuring one element before
 * and after and paying back the difference is the whole fix, and it costs two
 * rect reads on a change that was going to reflow the page anyway.
 */
function hold(anchor: Element | null, mutate: () => void) {
  if (!anchor) {
    mutate();
    return;
  }

  const before = anchor.getBoundingClientRect().top;
  mutate();
  const after = anchor.getBoundingClientRect().top;

  if (after !== before) window.scrollBy(0, after - before);
}

/**
 * Whatever is at the top of the document column right now.
 *
 * `elementFromPoint` rather than a scan of the body's children: the answer is
 * the same and it is one call instead of one rect read per block, which on a
 * large document is the difference between free and visible. The fixed reading
 * layer above the page sets `pointer-events: none`, so it is never the answer.
 */
function topOfViewport(body: HTMLElement): Element | null {
  const box = body.getBoundingClientRect();
  const x = Math.min(
    Math.max(box.left + box.width / 2, 0),
    Math.max(0, window.innerWidth - 1),
  );

  const found = document.elementFromPoint(x, 1);
  return found && body.contains(found) ? found : null;
}
