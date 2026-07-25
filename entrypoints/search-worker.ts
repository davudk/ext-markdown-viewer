/**
 * The search worker.
 *
 * Matching runs here and nowhere else, for one reason that matters more than
 * throughput: the reader is allowed to type a regular expression, and a regular
 * expression is the one input in this extension that can take unbounded time on
 * a bounded document. `(a+)+$` against a long run of `a` does not yield between
 * backtracking steps, so nothing running in the same thread can interrupt it —
 * no timer fires, no clock is read, and the only thing that stops it is killing
 * the thread. `worker.terminate()` is that, and it exists only because the work
 * is over here. `lib/search-client.ts` holds the watchdog that calls it.
 *
 * **How this file is loaded is not what it looks like.** It is written as a WXT
 * unlisted script because every file under `entrypoints/` must be one, and WXT
 * duly emits `search-worker.js` into the build — but nothing loads that copy. A
 * content script's realm has the *page's* origin, and a worker script must be
 * same-origin with the document that constructs it, so
 * `new Worker(chrome.runtime.getURL('search-worker.js'))` is a cross-origin load
 * and is refused however web-accessible the resource is made. What actually runs
 * is the bundle Vite inlines at `?worker&inline`, handed to `new Worker` as a
 * blob — or as a `data:` URL where blobs are refused — both same-origin with the
 * page by construction, and both entirely self-contained. That last part is not
 * incidental: a blob worker cannot `importScripts` an extension URL, so a worker
 * that reached for its dependencies at runtime could not be built this way at
 * all. Everything this one needs is bundled into it.
 *
 * The body is `handleRequest` from `lib/search.ts` and a `postMessage`. Keeping
 * the logic there rather than here is what lets the main thread run the identical
 * code when no worker can be created — see `lib/search-client.ts` — and lets the
 * tests exercise it in bare node.
 */

import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';

import { createCache, handleRequest, type WorkerRequest } from '@/lib/search';

function install() {
  const cache = createCache();

  self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const answer = handleRequest(event.data, cache);
    // `put` and `drop` have no answer. Posting one anyway would make every cache
    // write look like a search that found nothing.
    if (answer) (self as unknown as Worker).postMessage(answer);
  };
}

// Module scope, because that is the entry point when this file is bundled as a
// worker. The default export below is the entry point WXT insists on for the
// standalone copy; `install` only assigns a handler, so running twice is running
// once.
install();

export default defineUnlistedScript(install);
