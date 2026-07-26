/**
 * Scroll memory: the part that touches the DOM.
 *
 * The measurable half — position encoding, key derivation, eviction — stays in
 * `lib/document-state.ts` and is deliberately *not* moved under this folder.
 * That module is no longer only ours: `lib/theme-presets.ts` keys per-document
 * theme pins with `documentKey`, and the command palette reads
 * `listRecentDocuments`. Moving it here would make `lib/` import `plugins/`,
 * which is backwards. What moves is everything that was a React effect.
 */

import {
  decodePosition,
  encodePosition,
  loadScrollPosition,
  saveScrollPosition,
  type AnchorOffset,
} from '../../lib/document-state.ts';
import type { Teardown } from '../../lib/plugins/types.ts';

/** Trailing throttle on scroll writes. Below a frame's worth of settling time. */
const SCROLL_SAVE_INTERVAL_MS = 400;

/**
 * Every heading carries an id from the render pass. Ids are the only landmarks
 * in the document that survive a font-size or width change, so they are what
 * positions are measured against.
 *
 * All six levels, not just `TOC_LEVELS`: an `h5` is a perfectly good landmark
 * even though it never appears in the table of contents.
 */
function measureAnchors(): AnchorOffset[] {
  const headings = document.querySelectorAll<HTMLElement>(
    'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]',
  );

  return [...headings]
    .map((heading) => ({
      id: heading.id,
      top: heading.getBoundingClientRect().top + window.scrollY,
    }))
    .sort((a, b) => a.top - b.top);
}

/** Whether the reader asked for a specific place, rather than just the file. */
function hasExplicitAnchor(url: string): boolean {
  if (location.hash.length > 1) return true;
  try {
    return new URL(url).hash.length > 1;
  } catch {
    return false;
  }
}

/**
 * Restores the previous position once the document has laid out, then keeps it
 * up to date as the reader scrolls. Returns the teardown.
 *
 * Restoring before layout would measure a document that is still one screen
 * tall and land at the top of it, which is why the caller only starts this once
 * the rendered document is on screen, and why the restore still waits two
 * animation frames after that: the caller says React has committed, the frames
 * say the browser has actually laid the result out.
 */
export function startScrollMemory(url: string): Teardown {
  let disposed = false;
  // Our own restoring scroll fires a scroll event; saving from it would
  // overwrite the position with wherever the restore happened to land while
  // the document was still settling.
  let restoring = true;
  let userScrolled = false;
  let lastSave = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const capture = () =>
    encodePosition(
      window.scrollY,
      document.documentElement.scrollHeight,
      measureAnchors(),
    );

  const flush = () => {
    if (disposed || restoring) return;
    lastSave = Date.now();
    void saveScrollPosition(url, capture());
  };

  const onScroll = () => {
    userScrolled = true;
    if (restoring || timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        flush();
      },
      Math.max(0, SCROLL_SAVE_INTERVAL_MS - (Date.now() - lastSave)),
    );
  };

  // A tab can be closed, backgrounded, or navigated away from without ever
  // firing another scroll event, so the throttled write above is not enough
  // on its own. `pagehide` is the one teardown signal bfcache does not skip.
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = () => flush();

  const restore = async () => {
    // An explicit #anchor is a stated destination; a remembered position is a
    // guess about one. The stated destination wins.
    if (hasExplicitAnchor(url)) return;

    const position = await loadScrollPosition(url);
    // The reader got there first — moving the page under them now would be
    // indistinguishable from a bug.
    if (disposed || !position || userScrolled) return;

    const documentHeight = document.documentElement.scrollHeight;
    const target = decodePosition(position, documentHeight, measureAnchors());
    const furthest = Math.max(0, documentHeight - window.innerHeight);

    window.scrollTo(0, Math.min(Math.max(0, target), furthest));
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  // No rAF under the bare test runner; the restore is then simply immediate.
  const frames =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            void restore().finally(() => {
              restoring = false;
            });
          }),
        )
      : (void restore().finally(() => {
          restoring = false;
        }),
        0);

  return () => {
    disposed = true;
    if (frames && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frames);
    }
    clearTimeout(timer);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  };
}
