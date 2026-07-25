/**
 * Getting a query to the matching engine and the answers back.
 *
 * Everything interesting about this file is a consequence of three facts, and
 * none of them is about search:
 *
 *   **A content script cannot load a worker from an extension URL.** Its realm
 *   carries the *page's* origin, and a worker script has to be same-origin with
 *   the document that constructs it, so `new Worker(chrome.runtime.getURL(…))`
 *   is refused no matter what `web_accessible_resources` says. The worker is
 *   therefore the bundle Vite inlines below, handed to `new Worker` as a blob —
 *   same-origin with the page by construction. Vite's wrapper falls back to a
 *   `data:` URL if blob construction is refused. Neither can `importScripts` an
 *   extension URL, which is why `entrypoints/search-worker.ts` reaches for
 *   nothing at runtime.
 *
 *   **Some documents get no worker at all.** A `file://` page has an opaque
 *   origin, and Chrome declines to run a worker for one. Local markdown is a
 *   first-class case for this extension, so "no worker" cannot mean "no search":
 *   `runLocally` runs the identical `handleRequest` on the main thread. It is
 *   the same code, so results cannot differ — only the ReDoS guarantee does, and
 *   `search` says which one is in force.
 *
 *   **A regular expression already running cannot be interrupted.** Not by a
 *   timer, not by a clock check, not by an AbortController. `terminate()` is the
 *   only thing that stops it, and it only exists for a worker. So a search that
 *   has not answered within `SEARCH_WORKER_TIMEOUT_MS` is treated as a wedged
 *   thread: the worker is killed, every request waiting on it is failed with a
 *   reason the panel can show, and the next search builds a fresh one. On the
 *   main-thread path there is nothing to kill, which is exactly why the fallback
 *   is a fallback.
 */

import {
  SEARCH_REGEX_BUDGET_MS,
  SEARCH_WORKER_TIMEOUT_MS,
} from './config.ts';
import {
  createCache,
  handleRequest,
  type Detail,
  type SearchOptions,
  type WorkerRequest,
  type WorkerResponse,
} from './search.ts';

// The worker, compiled and inlined into this bundle. See the header for why it
// cannot simply be a URL.
import SearchWorker from '@/entrypoints/search-worker?worker&inline';

/* -------------------------------------------------------------------------- */
/* Where the work happens                                                      */
/* -------------------------------------------------------------------------- */

export type Transport = 'worker' | 'main';

export interface SearchRequest {
  runId: number;
  key: string;
  /** Supplied for a one-shot document (a file in a folder), omitted for a cached one. */
  text?: string;
  query: string;
  options: SearchOptions;
  detail: Detail;
  limit: number;
  signal?: AbortSignal;
}

/** Why a search produced nothing. `timeout` is the wedged-worker case. */
export type SearchFailure = { reason: 'aborted' } | { reason: 'timeout' };

/**
 * What a caller can get back. `pong` is deliberately not in it: the handshake is
 * this file's business, and leaving it in the union would make every call site
 * handle a case that can never reach it.
 */
export type SearchAnswer =
  | Extract<WorkerResponse, { kind: 'invalid' } | { kind: 'result' }>
  | SearchFailure;

export function isFailure(value: SearchAnswer): value is SearchFailure {
  return 'reason' in value;
}

interface Pending {
  resolve: (value: SearchAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

/* -------------------------------------------------------------------------- */
/* The client                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One worker per page, shared by quick find and the sidebar panel.
 *
 * Shared deliberately: both search the same open document, and the document is
 * cached in the worker by key, so a second worker would mean sending a
 * multi-megabyte string twice and keeping two copies of it warm.
 */
export class SearchClient {
  private worker: Worker | null = null;
  /** Null until the first attempt; `'main'` once a worker has been ruled out. */
  private transport: Transport | null = null;
  private pending = new Map<number, Pending>();
  /** Documents put into the worker, so a replacement can be refilled. */
  private cached = new Map<string, string>();
  /** The main-thread engine's cache. Only built if it is ever needed. */
  private local = createCache();
  private nextTicket = 1;

  /** Where searching currently happens. `null` before the first search. */
  get where(): Transport | null {
    return this.transport;
  }

  /* --- the worker itself -------------------------------------------------- */

  /**
   * The live worker, built on demand.
   *
   * Construction is guarded rather than probed: a refused origin throws
   * synchronously, and a worker that loads but never runs is caught by the same
   * timeout that catches a wedged one. Adding a handshake round-trip in front of
   * every session would only move the same failure later.
   */
  private ensure(): Worker | null {
    if (this.transport === 'main') return null;
    if (this.worker) return this.worker;

    try {
      const worker = new SearchWorker({ name: 'mdv-search' });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.settle(event.data);
      // A script that fails to load asynchronously — the `file://` case, among
      // others — arrives here rather than at the constructor.
      worker.onerror = () => this.demote();
      worker.onmessageerror = () => this.demote();

      this.worker = worker;
      this.transport = 'worker';

      // Whatever the previous worker was holding, so a replacement after a
      // termination does not make the next search re-send the whole document.
      for (const [key, text] of this.cached) {
        worker.postMessage({ kind: 'put', key, text } satisfies WorkerRequest);
      }

      return worker;
    } catch {
      // No worker in this document. Not an error the reader needs to hear about
      // — search still works, it just works here.
      this.transport = 'main';
      return null;
    }
  }

  /** Kills the worker and fails everything waiting on it. */
  private demote() {
    this.worker?.terminate();
    this.worker = null;
    this.transport = 'main';

    // Whatever the worker was holding has to exist here now, or the first search
    // after a demotion searches a document this thread has never been given.
    for (const [key, text] of this.cached) {
      handleRequest({ kind: 'put', key, text }, this.local);
    }

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ reason: 'timeout' });
    }
    this.pending.clear();
  }

  private settle(response: WorkerResponse) {
    if (response.kind === 'pong') return;

    // Keyed on runId: the client issues one search per run, and the worker
    // answers in order, so this is a lookup rather than a queue.
    const pending = this.pending.get(response.runId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(response.runId);
    pending.resolve(response);
  }

  /* --- documents ---------------------------------------------------------- */

  /** Caches a document under `key`. Cheap to call again with the same text. */
  put(key: string, text: string) {
    if (this.cached.get(key) === text) return;
    this.cached.set(key, text);

    const worker = this.ensure();
    if (worker) worker.postMessage({ kind: 'put', key, text } satisfies WorkerRequest);
    else handleRequest({ kind: 'put', key, text }, this.local);
  }

  drop(key: string) {
    this.cached.delete(key);

    const worker = this.worker;
    if (worker) worker.postMessage({ kind: 'drop', key } satisfies WorkerRequest);
    handleRequest({ kind: 'drop', key }, this.local);
  }

  /* --- searching ---------------------------------------------------------- */

  /**
   * One document, one answer.
   *
   * Always a promise, even on the main-thread path, so the callers have one
   * shape to write against — and so the fallback yields to the event loop
   * between documents instead of scanning a folder in a single task.
   */
  search(request: SearchRequest): Promise<SearchAnswer> {
    if (request.signal?.aborted) return Promise.resolve({ reason: 'aborted' });

    const message: WorkerRequest = {
      kind: 'search',
      runId: request.runId,
      key: request.key,
      text: request.text,
      query: request.query,
      options: request.options,
      detail: request.detail,
      limit: request.limit,
      budgetMs: SEARCH_REGEX_BUDGET_MS,
    };

    if (request.text !== undefined) this.cached.set(request.key, request.text);

    const worker = this.ensure();
    if (!worker) return this.runLocally(message, request.signal);

    // One ticket per in-flight search rather than reusing `runId`: the panel
    // issues a search per file inside a single run, and two of them waiting on
    // the same key would lose an answer.
    const ticket = this.nextTicket;
    this.nextTicket += 1;
    message.runId = ticket;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Nothing came back in time. The thread is assumed wedged on a
        // catastrophic pattern — the one failure a clock inside the worker
        // cannot catch — so it is killed rather than waited on.
        this.demote();
      }, SEARCH_WORKER_TIMEOUT_MS);

      this.pending.set(ticket, {
        timer,
        resolve: (value) => {
          request.signal?.removeEventListener('abort', onAbort);
          // Restore the caller's run id: the ticket is this class's bookkeeping
          // and means nothing above it.
          resolve(isFailure(value) ? value : { ...value, runId: request.runId });
        },
      });

      const onAbort = () => {
        const pending = this.pending.get(ticket);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(ticket);
        // The worker is left to finish and its answer dropped. Terminating a
        // healthy worker to save a few milliseconds of its time would throw
        // away the cached document with it.
        resolve({ reason: 'aborted' });
      };

      request.signal?.addEventListener('abort', onAbort, { once: true });

      worker.postMessage(message);
    });
  }

  /**
   * The same engine, on this thread, one document per task.
   *
   * The `await` before the work is what keeps a folder-wide search from becoming
   * one long task: each document is scanned in its own turn of the event loop,
   * so results stream and the page still responds between them. Within a single
   * document there is nothing to yield to — which is the honest limit of this
   * path, and the reason it is only taken when there is no worker to be had.
   */
  private async runLocally(
    message: WorkerRequest,
    signal: AbortSignal | undefined,
  ): Promise<SearchAnswer> {
    await Promise.resolve();
    if (signal?.aborted) return { reason: 'aborted' };

    const answer = handleRequest(message, this.local);
    // A `search` request always produces an answer; the null is `put`/`drop`,
    // which never reach here.
    return answer && answer.kind !== 'pong' ? answer : { reason: 'aborted' };
  }

  /** Frees the worker and everything it is holding. */
  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.cached.clear();
    this.local = createCache();
  }
}

/**
 * The page's client.
 *
 * A module singleton rather than a React context: quick find and the sidebar
 * panel are mounted in different subtrees by a shell this feature is not allowed
 * to restructure, and the thing they need to share is a cache, not a render.
 */
let shared: SearchClient | null = null;

export function searchClient(): SearchClient {
  shared ??= new SearchClient();
  return shared;
}
