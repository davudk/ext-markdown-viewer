/**
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ THE ONLY NETWORK CALL IN THE EXTENSION.                                │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * `scripts/audit-network.mjs` fails the build on any `fetch(` in the source
 * tree that is not named by `FETCH_ALLOWLIST` in lib/config.ts, and this file
 * is the single exemption it needs. It stays under `lib/` rather than moving
 * into `plugins/live-reload/` for exactly that reason: the audit walks `lib`,
 * `entrypoints` and `components`, so a request made from a plugin folder would
 * not be policed at all. The plugin owns the *lifecycle*; the request itself
 * stays in an audited directory.
 *
 * The guarantee that makes the exemption safe is enforced in
 * `liveReloadTarget()` below, not by convention:
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
 *
 * This module is deliberately framework-free — it was a React hook, and being
 * one meant it could only be tested by rendering a tree. A plugin has no tree.
 */

import { SUPPORTED_PROTOCOLS } from './config.ts';
import { documentKey } from './document-state.ts';

const LIVE_RELOAD_INTERVAL_MS = 3_000;
const LIVE_RELOAD_MAX_INTERVAL_MS = 60_000;
/** Consecutive failures after which the file is presumed gone for good. */
const LIVE_RELOAD_MAX_FAILURES = 8;

export interface LiveReloadOptions {
  /** The document's own address. The only thing this may request. */
  url: string;
  /**
   * The source currently on screen. Optional: without it the first poll simply
   * establishes the baseline, but passing it catches an edit that landed
   * between the page loading and the first poll.
   */
  source?: string;
  onChange: (source: string) => void;
}

/**
 * The one address this may request; null disables polling.
 *
 * The fragment is dropped because it is never sent anyway, and the result is
 * checked against the page's own location so that a `url` that has drifted from
 * the document — a wiring mistake, or worse — silently disables live reload
 * rather than requesting somewhere new. A document opened through a directory
 * handle carries an `mdv-folder:` URL, which fails the protocol check, so
 * polling switches itself off rather than being pointed at the page it replaced.
 */
export function liveReloadTarget(url: string): string | null {
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
 * Returns the stop function — always, even when polling never starts, so the
 * caller has nothing to branch on.
 *
 * Conditional requests do the real work: with an ETag or Last-Modified the
 * steady state is a 304 with no body, which is about as close to free as
 * polling gets. Servers that send neither fall back to comparing the text.
 */
export function startLiveReload({
  url,
  source,
  onChange,
}: LiveReloadOptions): () => void {
  const permitted = liveReloadTarget(url);
  if (permitted === null) return () => {};
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
  let baseline = source;

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

      if (baseline === undefined) {
        baseline = text;
      } else if (text !== baseline) {
        baseline = text;
        onChange(text);
      }

      schedule(LIVE_RELOAD_INTERVAL_MS);
    } catch {
      // Includes the abort on stop, which must not reschedule anything.
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
}
