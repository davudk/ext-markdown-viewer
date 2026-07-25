/**
 * Everything the sidebar knows that is not a DOM node: which tab is open,
 * whether the rail is collapsed, and what each tab has said about itself.
 *
 * Deliberately outside React. Two reasons, and both are consequences of the
 * plugin model rather than taste:
 *
 *   - `setup` runs before anything renders, and the capability it publishes has
 *     to be callable from another plugin's shortcut handler — which is not in a
 *     React tree and cannot reach a `useState` setter.
 *   - it makes the tab-selection rules (restore, blocked, the way back from a
 *     shortcut) testable under the bare runner, which cannot load a `.tsx` file
 *     at all.
 */

import { Store } from '../../lib/plugins/registry.ts';
import type { SidebarApi, SidebarTabReport } from './tabs.ts';

/** Viewport width below which the sidebar starts collapsed rather than eating the measure. */
const AUTO_COLLAPSE_PX = 900;

export interface SidebarSnapshot {
  expanded: boolean;
  /** Null until the first tab exists; the component then lands on the first one. */
  selected: string | null;
  /**
   * Bumped when a tab was opened by its own shortcut, which is the only moment
   * a panel may take focus. Clicking a tab, or arrowing across the strip, must
   * leave focus on the button the reader is standing on.
   */
  focusToken: number;
  /** Which tab the token is for, so a chord never focuses somebody else's panel. */
  focusedKey: string | null;
  hints: Readonly<Record<string, string | null>>;
  blocked: readonly string[];
}

export class SidebarState implements SidebarApi {
  readonly store: Store<SidebarSnapshot>;

  /** The tab a shortcut interrupted, and where focus was when it did. */
  private previous: string | null = null;
  private restoreTo: HTMLElement | null = null;

  private readonly persist: (key: string) => void;

  // Assigned rather than a parameter property: the bare runner strips types
  // only, and a parameter property is syntax it would have to rewrite.
  constructor(persist: (key: string) => void = () => {}) {
    this.persist = persist;
    this.store = new Store<SidebarSnapshot>({
      expanded: startsExpanded(),
      selected: null,
      focusToken: 0,
      focusedKey: null,
      hints: {},
      blocked: [],
    });
  }

  private patch(next: Partial<SidebarSnapshot>): void {
    this.store.set({ ...this.store.get(), ...next });
  }

  setExpanded(expanded: boolean): void {
    this.patch({ expanded });
  }

  /**
   * Picking a tab by hand, as opposed to a shortcut opening one.
   *
   * Clearing the two fields here is what stops Escape, pressed ten minutes
   * later, from yanking the sidebar back to a tab the reader deliberately left.
   */
  select(key: string): void {
    this.previous = null;
    this.restoreTo = null;
    this.settle(key);
  }

  openViaShortcut(key: string): void {
    const { selected } = this.store.get();

    if (selected !== key) {
      this.previous = selected;
      const active = typeof document === 'undefined' ? null : document.activeElement;
      this.restoreTo = active instanceof HTMLElement ? active : null;
      this.settle(key);
    }

    // The sidebar may be collapsed to its rail, in which case the panel is
    // rendered but `hidden`, and focusing into it would be focusing nothing.
    this.patch({
      expanded: true,
      focusToken: this.store.get().focusToken + 1,
      focusedKey: key,
    });
  }

  /**
   * Undo whatever a shortcut did: the tab that was showing comes back, and focus
   * goes where it was. Both are needed — restoring the tab and leaving focus in
   * a panel that is now hidden strands the reader's cursor off screen.
   *
   * Does nothing when the tab was reached by clicking: there is then no "before"
   * to return to, and Escape should not move anything.
   */
  dismiss(): void {
    const back = this.previous;
    this.previous = null;
    if (back) this.settle(back);

    const restore = this.restoreTo;
    this.restoreTo = null;
    if (restore?.isConnected) restore.focus();
  }

  report(key: string, report: SidebarTabReport): void {
    const current = this.store.get();
    const hint = report.hint ?? null;
    const blocked = report.blocked ?? false;

    const hintChanged = current.hints[key] !== hint;
    const blockedChanged = current.blocked.includes(key) !== blocked;
    // Panels report from an effect that runs on every render of theirs; without
    // this the store would notify, re-render them, and report again forever.
    if (!hintChanged && !blockedChanged) return;

    this.patch({
      hints: { ...current.hints, [key]: hint },
      blocked: blocked
        ? [...current.blocked, key].filter(unique)
        : current.blocked.filter((entry) => entry !== key),
    });
  }

  /**
   * Land on a tab that exists and can work.
   *
   * A remembered tab that cannot work in this browser is not worth landing on;
   * one that is merely empty still is, because that is where the button to fill
   * it lives. A remembered tab whose plugin has since been disabled is simply
   * not in `available` any more.
   */
  restore(stored: string | null, available: readonly string[]): void {
    const { blocked } = this.store.get();
    const usable = (key: string | null) =>
      key !== null && available.includes(key) && !blocked.includes(key);

    if (usable(stored)) this.patch({ selected: stored });
    else if (!usable(this.store.get().selected)) {
      this.patch({ selected: available.find((key) => !blocked.includes(key)) ?? null });
    }
  }

  private settle(key: string): void {
    this.patch({ selected: key });
    this.persist(key);
  }
}

/** Narrow windows open collapsed; the reader can still pull the sidebar out. */
function startsExpanded(): boolean {
  if (typeof matchMedia !== 'function') return true;
  return !matchMedia(`(max-width: ${AUTO_COLLAPSE_PX}px)`).matches;
}

function unique<T>(value: T, index: number, all: T[]): boolean {
  return all.indexOf(value) === index;
}
