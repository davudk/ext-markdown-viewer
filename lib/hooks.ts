/**
 * The React hooks the viewer shell composes: scroll memory, keyboard shortcuts,
 * and live reload.
 *
 * They live here rather than inside components because all three are pure
 * side-effect plumbing around browser APIs — nothing they do belongs to any one
 * component, and keeping them out of the tree means the shell stays a layout
 * file. The measurable logic (position encoding, key normalization, eviction)
 * lives in `document-state.ts` where it can be tested without a DOM.
 *
 * Every one of them degrades to doing nothing: a document that cannot remember
 * its scroll position, respond to `t`, or notice an edit is still a document.
 */

import { useEffect, useRef } from 'react';

import { SHORTCUTS, SUPPORTED_PROTOCOLS } from './config.ts';
import {
  decodePosition,
  documentKey,
  encodePosition,
  loadScrollPosition,
  saveScrollPosition,
  type AnchorOffset,
} from './document-state.ts';

/* -------------------------------------------------------------------------- */
/* Scroll memory                                                               */
/* -------------------------------------------------------------------------- */

/** Trailing throttle on scroll writes. Below a frame's worth of settling time. */
const SCROLL_SAVE_INTERVAL_MS = 400;

export interface ScrollMemoryOptions {
  /** The document's own address. */
  url: string;
  /** The `rememberScroll` setting. */
  enabled: boolean;
  /** True once the rendered document is in the DOM and can be measured. */
  ready: boolean;
}

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
 * up to date as the reader scrolls.
 *
 * Restoring before layout would measure a document that is still one screen
 * tall and land at the top of it, which is why this waits on `ready` *and* two
 * animation frames: `ready` says React has committed, the frames say the
 * browser has actually laid the result out.
 */
export function useScrollMemory({ url, enabled, ready }: ScrollMemoryOptions) {
  useEffect(() => {
    if (!enabled || !ready) return;

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

    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void restore().finally(() => {
          restoring = false;
        });
      }),
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [url, enabled, ready]);
}

/* -------------------------------------------------------------------------- */
/* Keyboard shortcuts                                                          */
/* -------------------------------------------------------------------------- */

export interface ShortcutHandlers {
  toggleToc?: () => void;
  toggleRaw?: () => void;
  cycleTheme?: () => void;
}

const ACTION_BY_KEY = new Map<string, keyof ShortcutHandlers>(
  Object.entries(SHORTCUTS).map(([action, key]) => [
    key,
    action as keyof ShortcutHandlers,
  ]),
);

/**
 * Whether a keystroke belongs to whatever the user is typing into. The raw view
 * and the search field a future version adds are both plain form controls, and
 * a bare `t` that toggles the sidebar mid-word is a bug, not a shortcut.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['input', 'textarea', 'select'].includes(
    target.tagName.toLowerCase(),
  );
}

/** Binds `SHORTCUTS`. Handlers may change between renders; the listener does not. */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Anything with a modifier belongs to the browser or the OS — Ctrl-D is a
      // bookmark, Cmd-R is a reload, and shadowing either would be hostile.
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.defaultPrevented || event.isComposing) return;
      if (isTypingTarget(event.target)) return;

      const action = ACTION_BY_KEY.get(event.key.toLowerCase());
      const handler = action && latest.current[action];
      if (!handler) return;

      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/* -------------------------------------------------------------------------- */
/* Live reload                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ THE ONLY NETWORK CALL IN THE EXTENSION.                                │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * `scripts/audit-network.mjs` fails the build on any `fetch(` in the bundle,
 * and this is the single exemption it needs. The guarantee that makes the
 * exemption safe is enforced in `liveReloadTarget()` below, not by convention:
 *
 *   · the only URL ever passed to `fetch` is the document's own address, minus
 *     its fragment, and it is re-derived from `location.href` — nothing read
 *     out of the document, out of storage, or out of a setting can steer it;
 *   · `redirect: 'error'` — following a redirect would mean requesting a URL we
 *     did not choose, so it is treated as a failure instead;
 *   · `credentials: 'same-origin'` and no `mode: 'cors'`, so this can never
 *     become a cross-origin request;
 *   · nothing is ever uploaded: no body, no beacon, no query parameter. The
 *     only headers sent are the conditional ones, echoing back values the same
 *     server just handed us.
 *
 * If the audit script ever reports a second `fetch(`, it is not this one.
 */
const LIVE_RELOAD_INTERVAL_MS = 3_000;
const LIVE_RELOAD_MAX_INTERVAL_MS = 60_000;
/** Consecutive failures after which the file is presumed gone for good. */
const LIVE_RELOAD_MAX_FAILURES = 8;

export interface LiveReloadOptions {
  /** The document's own address. The only thing this hook may request. */
  url: string;
  /** The `liveReload` setting. */
  enabled: boolean;
  /**
   * The source currently on screen. Optional: without it the first poll simply
   * establishes the baseline, but passing it catches an edit that landed
   * between the page loading and the first poll.
   */
  source?: string;
  onChange: (source: string) => void;
}

/**
 * The one address this hook is allowed to request; null disables polling.
 *
 * The fragment is dropped because it is never sent anyway, and the result is
 * checked against the page's own location so that a `url` prop that has drifted
 * from the document — a wiring mistake, or worse — silently disables live
 * reload rather than requesting somewhere new.
 */
function liveReloadTarget(url: string): string | null {
  const target = documentKey(url);

  try {
    if (!SUPPORTED_PROTOCOLS.includes(new URL(target).protocol)) return null;
  } catch {
    return null;
  }

  return documentKey(location.href) === target ? target : null;
}

/** Exponential, capped. A server that is down must not be hammered. */
function backoff(failures: number): number {
  return Math.min(
    LIVE_RELOAD_INTERVAL_MS * 2 ** failures,
    LIVE_RELOAD_MAX_INTERVAL_MS,
  );
}

/**
 * Re-reads the document's own file on a timer and reports a changed body.
 *
 * Conditional requests do the real work: with an ETag or Last-Modified the
 * steady state is a 304 with no body, which is about as close to free as
 * polling gets. Servers that send neither fall back to comparing the text.
 */
export function useLiveReload({
  url,
  enabled,
  source,
  onChange,
}: LiveReloadOptions) {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  const baseline = useRef(source);
  useEffect(() => {
    if (source !== undefined) baseline.current = source;
  }, [source]);

  useEffect(() => {
    if (!enabled) return;

    const permitted = liveReloadTarget(url);
    if (permitted === null) return;
    // Annotated, not inferred: `poll` is hoisted, so a narrowed `string | null`
    // would widen back to nullable inside it.
    const target: string = permitted;

    // file:// has no conditional-request story and, in most builds, no fetch
    // story either — the request is refused outright. One attempt is enough to
    // find out; retrying would just fail forever on a timer.
    const givesUpOnFirstFailure = target.startsWith('file:');

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    let etag: string | null = null;
    let lastModified: string | null = null;

    const schedule = (delay: number) => {
      if (!stopped) timer = setTimeout(poll, delay);
    };

    const stop = () => {
      stopped = true;
    };

    async function poll() {
      if (stopped) return;

      // A background tab has no reader to notice the update, and polling one is
      // pure battery cost. Re-check on the next tick instead.
      if (document.visibilityState === 'hidden') {
        schedule(LIVE_RELOAD_INTERVAL_MS);
        return;
      }

      const headers: Record<string, string> = {};
      if (etag) headers['If-None-Match'] = etag;
      else if (lastModified) headers['If-Modified-Since'] = lastModified;

      try {
        const response = await fetch(target, {
          headers,
          signal: controller.signal,
          // Revalidate rather than being handed back the copy that was cached
          // when the page loaded — otherwise the poll can never see a change.
          cache: 'no-cache',
          credentials: 'same-origin',
          redirect: 'error',
        });

        if (stopped) return;

        // Nothing changed: the cheap, expected outcome.
        if (response.status === 304) {
          failures = 0;
          schedule(LIVE_RELOAD_INTERVAL_MS);
          return;
        }

        // An opaque response has an unreadable body that reads as empty — which
        // would blank the document. Treat it as a failure, not as an edit.
        if (response.type === 'opaque' || response.type === 'opaqueredirect') {
          throw new Error('opaque response');
        }

        // A successful file:// read reports status 0 rather than 200.
        if (!response.ok && response.status !== 0) {
          throw new Error(`status ${response.status}`);
        }

        const text = await response.text();
        if (stopped) return;

        failures = 0;
        etag = response.headers.get('etag');
        lastModified = response.headers.get('last-modified');

        if (baseline.current === undefined) {
          baseline.current = text;
        } else if (text !== baseline.current) {
          baseline.current = text;
          latest.current(text);
        }

        schedule(LIVE_RELOAD_INTERVAL_MS);
      } catch {
        // Includes the abort on unmount, which must not reschedule anything.
        if (stopped || controller.signal.aborted) return;

        failures += 1;
        if (givesUpOnFirstFailure || failures >= LIVE_RELOAD_MAX_FAILURES) {
          stop();
          return;
        }
        schedule(backoff(failures));
      }
    }

    schedule(LIVE_RELOAD_INTERVAL_MS);

    return () => {
      stop();
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, enabled]);
}
