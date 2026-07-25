/**
 * The shared view of the rendered document.
 *
 * Four components used to locate `.mdv-body` for themselves and three ran their
 * own `MutationObserver`. This is the one observer and the one enhancement
 * frame they all now share, which also makes "is the raw view showing" a single
 * answer rather than a prop threaded through five files.
 */

import type { Heading } from '@/lib/markdown';
import { Store } from './registry.ts';
import type { DocumentHandle, Teardown } from './types.ts';

export interface DocumentState {
  body: HTMLElement | null;
  source: string;
  /**
   * The rendered HTML, before any plugin enhanced it.
   *
   * Carried because `body` is post-enhancement — it has copy buttons and anchor
   * links grafted in — and `source` is markdown. A plugin needing the document
   * as markup would otherwise reparse the whole thing, which the presentation
   * pilot was doing on every open.
   */
  html: string;
  headings: readonly Heading[];
  url: string;
  isRaw: boolean;
}

type Pass = (body: HTMLElement) => Teardown | void;

export class SharedDocument implements DocumentHandle {
  private state: DocumentState = {
    body: null,
    source: '',
    html: '',
    headings: [],
    url: '',
    isRaw: false,
  };

  /**
   * Bumped on every update, so React can subscribe.
   *
   * Found by the presentation pilot: `useDocument()` watched the host's status
   * store, which only tracks enable/disable, so the documented pattern — a
   * contribution reading `isRaw` and returning null — never re-rendered on a
   * raw toggle.
   */
  readonly version = new Store(0);

  private readonly passes = new Set<Pass>();
  /** What each pass last returned, so a re-run undoes the previous one first. */
  private readonly undo = new Map<Pass, Teardown | void>();
  private readonly watchers = new Set<(body: HTMLElement) => void>();
  private frame = 0;

  get body() {
    return this.state.body;
  }
  get source() {
    return this.state.source;
  }
  get html() {
    return this.state.html;
  }
  get headings() {
    return this.state.headings;
  }
  get url() {
    return this.state.url;
  }
  get isRaw() {
    return this.state.isRaw;
  }

  /** Called by the shell whenever the rendered document changes. */
  update(next: DocumentState): void {
    const bodyChanged = next.body !== this.state.body;
    this.state = next;

    // A new body element means the old passes' teardowns point at detached
    // nodes. Drop them rather than running them against a document that no
    // longer exists.
    if (bodyChanged) this.undo.clear();

    this.version.set(this.version.get() + 1);
    this.schedule();
    if (next.body) for (const watcher of this.watchers) watcher(next.body);
  }

  // Arrow properties, not methods: these get passed to `useSyncExternalStore`,
  // which calls them unbound.
  onChange = (fn: (body: HTMLElement) => void): Teardown => {
    this.watchers.add(fn);
    if (this.state.body) fn(this.state.body);
    return () => {
      this.watchers.delete(fn);
    };
  };

  enhance(pass: Pass): Teardown {
    this.passes.add(pass);
    this.schedule();

    return () => {
      this.passes.delete(pass);
      this.runUndo(pass);
    };
  }

  refresh(): void {
    this.schedule();
  }

  /** Unwinds every pass. Used when the host tears the whole thing down. */
  dispose(): void {
    for (const pass of [...this.passes]) this.runUndo(pass);
    this.passes.clear();
    this.watchers.clear();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /**
   * One batched frame for every plugin's pass.
   *
   * After paint rather than during: a multi-megabyte README is on screen and
   * scrollable before any plugin touches it, and a pass that reads layout is
   * not competing with the render that produced it.
   */
  private schedule(): void {
    if (this.frame || typeof requestAnimationFrame !== 'function') {
      if (typeof requestAnimationFrame !== 'function') this.runPasses();
      return;
    }

    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.runPasses();
    });
  }

  private runPasses(): void {
    const body = this.state.body;
    if (!body) return;

    for (const pass of this.passes) {
      this.runUndo(pass);
      try {
        this.undo.set(pass, pass(body));
      } catch (error) {
        // One plugin's pass must not stop the others from running.
        console.error('[mdv] an enhancement pass threw', error);
      }
    }
  }

  private runUndo(pass: Pass): void {
    const teardown = this.undo.get(pass);
    this.undo.delete(pass);
    if (typeof teardown !== 'function') return;
    try {
      teardown();
    } catch (error) {
      console.error('[mdv] an enhancement teardown threw', error);
    }
  }
}
