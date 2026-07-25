/**
 * Per-document scroll memory.
 *
 * Lives in chrome.storage.local under its own key, next to but separate from
 * settings, so "forget where I was in every document" is one `remove` and never
 * touches the user's preferences.
 *
 * Every chrome.* call is guarded for the same reason `settings.ts` guards its
 * own: this runs inside the renderer, which has already replaced the page
 * content. A storage failure has to cost the reader their scroll position and
 * nothing else — never the document.
 */

import { DOCUMENT_STATE_KEY, DOCUMENT_STATE_LIMIT } from './config.ts';

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where the reader was, expressed so it survives a reflow.
 *
 * A raw pixel offset is the obvious encoding and the wrong one: the same
 * document at a larger font size, a narrower window, or a different content
 * width setting is a different number of pixels tall, so `scrollTo(previousY)`
 * lands somewhere the reader has never been. Both fields here are relative to
 * content instead of to pixels:
 *
 *   `anchor` + `sectionRatio` — the heading the reader was under, plus how far
 *   through that section they had read. Headings are the only landmarks that
 *   survive reflow, and restoring proportionally within one section keeps the
 *   error bounded by that section's length rather than by the document's.
 *
 *   `ratio` — position as a fraction of total document height, used when the
 *   anchor is gone (the file was edited, a heading renamed) or when the
 *   document has no headings at all. Coarse, but never wildly wrong.
 *
 * `ratio` is deliberately measured against full document height, not against
 * the scrollable range, so it does not shift when the window is resized.
 */
export interface ScrollPosition {
  /** Id of the nearest heading at or above the viewport top, if any. */
  anchor: string | null;
  /** How far into that heading's section the viewport top sat, 0–1. */
  sectionRatio: number;
  /** Viewport top as a fraction of document height, 0–1. The fallback. */
  ratio: number;
}

/** A heading's id and its absolute offset from the top of the document. */
export interface AnchorOffset {
  id: string;
  top: number;
}

interface DocumentEntry {
  position: ScrollPosition;
  /** Last read *or* write. This is the recency ordering eviction uses. */
  usedAt: number;
}

type DocumentStates = Record<string, DocumentEntry>;

/**
 * A scroll position within this many pixels of a heading is recorded as being
 * *at* that heading, so clicking an anchor and reloading returns to the anchor
 * rather than to a hair above it.
 */
const ANCHOR_SNAP_PX = 4;

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The storage key for a document's URL.
 *
 * The fragment is dropped: it selects a place *within* a document that is
 * already loaded, so `notes.md` and `notes.md#setup` are one document and must
 * share one entry, or the same file reached two ways remembers two positions.
 *
 * The query is deliberately kept. Unlike a fragment it routinely selects *which*
 * document is served — `?file=README.md`, `?ref=main`, `?raw=1` — so stripping
 * it would collapse genuinely different files onto a single entry and have them
 * overwrite each other's positions. A cache-busting `?v=` costs a duplicate
 * entry, which the LRU absorbs; the other mistake silently loses data.
 */
export function documentKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    // Not parseable (an odd scheme, a relative string). Strip the fragment
    // textually rather than dropping the entry entirely.
    return url.split('#')[0];
  }
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Turn a measured scroll offset into a reflow-tolerant position.
 *
 * `anchors` must be sorted by `top`; `measureAnchors` in hooks.ts guarantees it.
 */
export function encodePosition(
  scrollTop: number,
  documentHeight: number,
  anchors: readonly AnchorOffset[],
): ScrollPosition {
  const ratio = documentHeight > 0 ? clamp01(scrollTop / documentHeight) : 0;

  let index = -1;
  for (let i = 0; i < anchors.length; i += 1) {
    if (anchors[i].top <= scrollTop + ANCHOR_SNAP_PX) index = i;
    else break;
  }

  if (index < 0) return { anchor: null, sectionRatio: 0, ratio };

  const start = anchors[index].top;
  const end = anchors[index + 1]?.top ?? documentHeight;
  const span = end - start;

  return {
    anchor: anchors[index].id,
    sectionRatio: span > 0 ? clamp01((scrollTop - start) / span) : 0,
    ratio,
  };
}

/**
 * Turn a stored position back into a scroll offset against the current layout.
 * The caller clamps to the scrollable range — only it knows the viewport height.
 */
export function decodePosition(
  position: ScrollPosition,
  documentHeight: number,
  anchors: readonly AnchorOffset[],
): number {
  const index = position.anchor
    ? anchors.findIndex((anchor) => anchor.id === position.anchor)
    : -1;

  // The heading is gone, so the document has been edited under us. The height
  // fraction is the honest answer: approximately as far through as before.
  if (index < 0) return position.ratio * documentHeight;

  const start = anchors[index].top;
  const end = anchors[index + 1]?.top ?? documentHeight;

  return start + clamp01(position.sectionRatio) * Math.max(0, end - start);
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

let lastStamp = 0;

/**
 * Monotonic timestamps. Two writes inside the same millisecond would tie, and a
 * tie in the eviction sort is resolved arbitrarily — which is exactly the
 * "arbitrary rather than least-recently-used" outcome this is meant to avoid.
 */
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function isScrollPosition(value: unknown): value is ScrollPosition {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ScrollPosition>;
  return (
    (candidate.anchor === null || typeof candidate.anchor === 'string') &&
    typeof candidate.sectionRatio === 'number' &&
    typeof candidate.ratio === 'number' &&
    Number.isFinite(candidate.sectionRatio) &&
    Number.isFinite(candidate.ratio)
  );
}

/**
 * Rebuild the map from whatever storage handed back, dropping anything that is
 * not a well-formed entry. Storage outlives the code that wrote it: an older
 * version, a half-finished write, or a user poking at the extension's data can
 * all leave junk here, and one bad entry must not poison the whole map.
 *
 * Always returns fresh objects, so callers can mutate the result freely.
 */
function sanitize(value: unknown): DocumentStates {
  if (typeof value !== 'object' || value === null) return {};

  const states: DocumentStates = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;

    const { position, usedAt } = entry as Partial<DocumentEntry>;
    if (!isScrollPosition(position) || typeof usedAt !== 'number') continue;

    states[key] = {
      position: {
        anchor: position.anchor,
        sectionRatio: position.sectionRatio,
        ratio: position.ratio,
      },
      usedAt,
    };
  }
  return states;
}

/**
 * Drop least-recently-used entries until the map fits. Recency is `usedAt`,
 * which both `saveScrollPosition` and `loadScrollPosition` refresh — a document
 * reopened every day but never scrolled is in active use and must outlive one
 * that was scrolled once a year ago.
 */
export function pruneToLimit(
  states: DocumentStates,
  limit: number = DOCUMENT_STATE_LIMIT,
): DocumentStates {
  const keys = Object.keys(states);
  if (keys.length <= limit) return states;

  const doomed = keys
    .sort((a, b) => states[a].usedAt - states[b].usedAt)
    .slice(0, keys.length - limit);

  for (const key of doomed) delete states[key];
  return states;
}

async function readAll(): Promise<DocumentStates> {
  try {
    const stored = await chrome.storage.local.get(DOCUMENT_STATE_KEY);
    return sanitize(stored[DOCUMENT_STATE_KEY]);
  } catch {
    // No chrome, no storage, or a torn-down context. Nothing remembered.
    return {};
  }
}

async function writeAll(states: DocumentStates): Promise<void> {
  try {
    await chrome.storage.local.set({ [DOCUMENT_STATE_KEY]: states });
  } catch {
    // Losing a scroll position is a non-event; throwing here would surface in
    // the renderer as an unhandled rejection on every scroll.
  }
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

export async function saveScrollPosition(
  url: string,
  position: ScrollPosition,
): Promise<void> {
  const states = await readAll();
  states[documentKey(url)] = { position, usedAt: stamp() };
  await writeAll(pruneToLimit(states));
}

/** Returns null when nothing is remembered, including when storage is broken. */
export async function loadScrollPosition(
  url: string,
): Promise<ScrollPosition | null> {
  const states = await readAll();
  const entry = states[documentKey(url)];
  if (!entry) return null;

  // Opening counts as use, so a frequently reopened document is not evicted
  // just because the reader never scrolls it.
  entry.usedAt = stamp();
  await writeAll(states);

  return entry.position;
}

export async function clearScrollPosition(url: string): Promise<void> {
  const states = await readAll();
  if (!(documentKey(url) in states)) return;

  delete states[documentKey(url)];
  await writeAll(states);
}

/**
 * Forget every document. Removes the key outright rather than storing an empty
 * map, so "cleared" and "never used" are the same state on disk.
 */
export async function clearAllScrollPositions(): Promise<void> {
  try {
    await chrome.storage.local.remove(DOCUMENT_STATE_KEY);
  } catch {
    // Same bargain as everywhere else here: best effort, never fatal.
  }
}

/** How many documents are currently remembered. For the options page. */
export async function countRememberedDocuments(): Promise<number> {
  return Object.keys(await readAll()).length;
}

/**
 * Remembered documents, most recently used first.
 *
 * This map is already a recency-ordered list of every document the reader has
 * opened — that is what `usedAt` is for and what eviction is measured against —
 * so "recent files" in the command palette is a read of it rather than a second
 * list kept alongside. No title is stored, deliberately: a document's title is
 * its first heading, which would mean parsing every remembered file to build a
 * menu. The caller has the URL and can name it from that.
 */
export async function listRecentDocuments(): Promise<
  { url: string; usedAt: number }[]
> {
  const states = await readAll();
  return Object.entries(states)
    .map(([url, entry]) => ({ url, usedAt: entry.usedAt }))
    .sort((a, b) => b.usedAt - a.usedAt);
}
