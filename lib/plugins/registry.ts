/**
 * The registries a plugin contributes into, and the store they share.
 *
 * All four are the same shape: something is added, something can be removed,
 * and anyone rendering from it needs to know when it changed. They are kept in
 * one file because they are one idea, not four.
 */

import type {
  Capabilities,
  CapabilityRegistry,
  Command,
  CommandRegistry,
  OverlayOptions,
  RegionName,
  ShortcutRegistry,
  Teardown,
  UiContribution,
} from './types.ts';

/**
 * A minimal observable, so React can subscribe through `useSyncExternalStore`
 * without pulling a state library in for four registries.
 */
export class Store<T> {
  private listeners = new Set<() => void>();
  private value: T;

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    // Copied before iterating: a listener that unsubscribes itself while being
    // notified would otherwise mutate the set mid-iteration.
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): Teardown => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/* -------------------------------------------------------------------------- */
/* Regions                                                                     */
/* -------------------------------------------------------------------------- */

export interface PlacedContribution extends UiContribution {
  pluginId: string;
  /** Registry index, so equal `order` values resolve deterministically. */
  sequence: number;
}

export class RegionRegistry {
  readonly store = new Store<readonly PlacedContribution[]>([]);
  /**
   * Counted, not a set: the shell declares the core regions and a plugin may
   * declare the same name. Without counting, whichever teardown ran first would
   * undeclare the region out from under the other — found by both pilots.
   */
  private declared = new Map<RegionName, number>();
  private sequence = 0;

  /** Publishes a region so contributions to it become renderable. */
  declare(name: RegionName): Teardown {
    this.declared.set(name, (this.declared.get(name) ?? 0) + 1);
    this.store.set([...this.store.get()]);

    let released = false;
    return () => {
      // Guarded: a teardown run twice must not decrement someone else's claim.
      if (released) return;
      released = true;

      const count = (this.declared.get(name) ?? 1) - 1;
      if (count <= 0) this.declared.delete(name);
      else this.declared.set(name, count);
      this.store.set([...this.store.get()]);
    };
  }

  has(name: RegionName): boolean {
    return this.declared.has(name);
  }

  add(pluginId: string, contributions: readonly UiContribution[]): Teardown {
    const placed = contributions.map((contribution) => ({
      ...contribution,
      pluginId,
      sequence: this.sequence++,
    }));

    this.store.set([...this.store.get(), ...placed]);

    return () => {
      const removing = new Set(placed);
      this.store.set(this.store.get().filter((entry) => !removing.has(entry)));
    };
  }

  /**
   * Contributions for a region, in render order.
   *
   * An undeclared region yields nothing rather than throwing: a plugin
   * contributing a sidebar tab while the sidebar is disabled is a normal state,
   * not a mistake anyone can act on.
   */
  for(name: RegionName): readonly PlacedContribution[] {
    if (!this.declared.has(name)) return [];
    return this.store
      .get()
      .filter((entry) => entry.region === name)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.sequence - b.sequence);
  }
}

/* -------------------------------------------------------------------------- */
/* Overlays                                                                    */
/* -------------------------------------------------------------------------- */

export interface OpenOverlay extends OverlayOptions {
  pluginId: string;
  instanceId: number;
}

/**
 * A stack, not a set.
 *
 * Before this, four features positioned themselves with `inset: 0` and picked
 * their own z-index — `40`, `2147482000`, and `2147483000` twice. Stacking is
 * now position in this array, so nothing has to guess, and opening an overlay
 * from an overlay unwinds in order.
 */
export class OverlayRegistry {
  readonly store = new Store<readonly OpenOverlay[]>([]);
  private nextId = 0;

  /** True when this plugin already has an overlay of that id open. */
  isIdOpen(pluginId: string, id: string): boolean {
    return this.store.get().some((o) => o.pluginId === pluginId && o.id === id);
  }

  open(pluginId: string, options: OverlayOptions): { instanceId: number; close: () => void } {
    // Idempotent per id: a shortcut pressed twice must not stack two decks, and
    // making every plugin guard that itself is how they all end up with one.
    const existing = this.store
      .get()
      .find((o) => o.pluginId === pluginId && o.id === options.id);
    if (existing) {
      const known = existing.instanceId;
      return { instanceId: known, close: () => this.close(known) };
    }

    const instanceId = this.nextId++;
    const entry: OpenOverlay = { ...options, pluginId, instanceId };
    this.store.set([...this.store.get(), entry]);

    const close = () => {
      const before = this.store.get();
      const after = before.filter((o) => o.instanceId !== instanceId);
      if (after.length === before.length) return; // already closed
      this.store.set(after);
      options.onClose?.();
    };

    return { instanceId, close };
  }

  /** Closes one overlay by id, firing its `onClose`. */
  close(instanceId: number): void {
    const before = this.store.get();
    const entry = before.find((o) => o.instanceId === instanceId);
    if (!entry) return;
    this.store.set(before.filter((o) => o.instanceId !== instanceId));
    entry.onClose?.();
  }

  isOpen(instanceId: number): boolean {
    return this.store.get().some((o) => o.instanceId === instanceId);
  }

  /** Closes everything a plugin left open, used when it is disabled. */
  closeFor(pluginId: string): void {
    for (const overlay of this.store.get().filter((o) => o.pluginId === pluginId)) {
      this.store.set(this.store.get().filter((o) => o.instanceId !== overlay.instanceId));
      overlay.onClose?.();
    }
  }

  top(): OpenOverlay | undefined {
    return this.store.get().at(-1);
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export class Commands implements CommandRegistry {
  readonly store = new Store<readonly Command[]>([]);

  add(command: Command): Teardown {
    this.store.set([...this.store.get(), command]);
    return () => this.store.set(this.store.get().filter((c) => c !== command));
  }

  all(): readonly Command[] {
    return this.store.get();
  }
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

export class CapabilityStore implements CapabilityRegistry {
  private values = new Map<string, unknown>();
  readonly store = new Store(0);

  provide<K extends keyof Capabilities>(name: K, value: Capabilities[K]): Teardown {
    this.values.set(name as string, value);
    this.store.set(this.store.get() + 1);

    return () => {
      // Only withdraw our own: a later provider replacing this one must not be
      // torn down by the earlier one's teardown running afterwards.
      if (this.values.get(name as string) === value) {
        this.values.delete(name as string);
        this.store.set(this.store.get() + 1);
      }
    };
  }

  use<K extends keyof Capabilities>(name: K): Capabilities[K] | undefined {
    return this.values.get(name as string) as Capabilities[K] | undefined;
  }

  onChange(fn: () => void): Teardown {
    return this.store.subscribe(fn);
  }
}

/* -------------------------------------------------------------------------- */
/* Shortcuts                                                                   */
/* -------------------------------------------------------------------------- */

interface Binding {
  key: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
  /**
   * Fire even while the reader is typing. Off by default: an unmodified key
   * that opens a surface mid-word is a bug, and the presentation pilot had to
   * copy the shell's private guard to avoid it — so it belongs here instead.
   */
  whileTyping?: boolean;
  run: (event: KeyboardEvent) => void;
}

/** Whether the keystroke belongs to whatever the reader is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase());
}

/**
 * One window listener for every plugin.
 *
 * Bindings are tried newest-first so a plugin that just opened a surface can
 * claim a key the shell also binds, and the first to handle it stops the rest.
 */
export class Shortcuts implements ShortcutRegistry {
  private bindings: Binding[] = [];
  private detach: Teardown | null = null;

  add(binding: Binding): Teardown {
    this.bindings.unshift(binding);
    this.ensureListener();
    return () => {
      this.bindings = this.bindings.filter((b) => b !== binding);
      if (this.bindings.length === 0) this.stop();
    };
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
  }

  private ensureListener(): void {
    if (this.detach || typeof window === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      // A key that is part of composing a character is not a shortcut.
      if (event.isComposing || event.defaultPrevented) return;

      const typing = isTypingTarget(event.target);
      const ctrlOrMeta = event.ctrlKey || event.metaKey;

      for (const binding of this.bindings) {
        if (typing && !binding.whileTyping && !ctrlOrMeta) continue;
        if (binding.key.toLowerCase() !== event.key.toLowerCase()) continue;
        if ((binding.ctrlOrMeta ?? false) !== ctrlOrMeta) continue;
        if ((binding.shift ?? false) !== event.shiftKey) continue;
        binding.run(event);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    this.detach = () => window.removeEventListener('keydown', onKeyDown, true);
  }
}
