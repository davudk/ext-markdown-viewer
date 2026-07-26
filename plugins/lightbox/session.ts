/**
 * What is currently being viewed, shared between the plugin's `setup` and the
 * overlay it opens.
 *
 * A UI contribution is a plain component with no props and no channel back to
 * the closure that opened it — so "which image was clicked" needs somewhere to
 * live that both halves can see. The sidebar pilot hit this first and answered
 * it with a capability, which is also the answer here: `setup` provides the
 * session, the overlay `use`s it, and neither imports the other's module.
 *
 * The store is ten lines rather than an import of the host's own `Store`,
 * because it is state this plugin owns and the host's registry is not a public
 * surface for plugins to reach into.
 */

export interface LightboxSlide {
  /** The element in the document. Kept for focus restore, never re-parented. */
  image: HTMLImageElement;
  src: string;
  alt: string;
  title: string;
}

export interface LightboxSnapshot {
  slides: readonly LightboxSlide[];
  index: number;
}

export interface LightboxApi {
  readonly store: {
    get(): LightboxSnapshot | null;
    subscribe(fn: () => void): () => void;
  };
  /** Wraps rather than stops: the counter says where you are, so a ring is safe. */
  step(delta: number): void;
}

// Declaration merging, as `Capabilities` documents: `use('lightbox')` is typed,
// and a typo is a compile error rather than a silent undefined.
declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    lightbox: LightboxApi;
  }
}

export class LightboxSession implements LightboxApi {
  private snapshot: LightboxSnapshot | null = null;
  private readonly watchers = new Set<() => void>();

  readonly store = {
    get: () => this.snapshot,
    subscribe: (fn: () => void) => {
      this.watchers.add(fn);
      return () => {
        this.watchers.delete(fn);
      };
    },
  };

  /**
   * The slide on screen, which is not always the image that was clicked: after
   * arrowing through a gallery the reader's place is where they navigated to.
   * Read on close, to put focus back there.
   */
  get current(): HTMLImageElement | null {
    if (!this.snapshot) return null;
    return this.snapshot.slides[this.snapshot.index]?.image ?? null;
  }

  open(slides: readonly LightboxSlide[], index: number): void {
    this.set({ slides, index });
  }

  clear(): void {
    this.set(null);
  }

  step(delta: number): void {
    const current = this.snapshot;
    if (!current) return;

    const count = current.slides.length;
    if (count === 0) return;

    this.set({ ...current, index: (current.index + delta + count) % count });
  }

  private set(next: LightboxSnapshot | null): void {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher();
  }
}
