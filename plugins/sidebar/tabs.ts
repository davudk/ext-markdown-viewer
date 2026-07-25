/**
 * What a sidebar tab is, and the region it lands in.
 *
 * The tab strip needs a label before it renders the tab's component — a button
 * has to say what it opens, and the panel behind it is exactly what has not been
 * shown yet. `UiContribution` carries no metadata, so the label rides along on
 * the contribution object: `PlacedContribution` spreads the contribution, so
 * extra fields survive into `regions.for()` untouched.
 *
 * A tab therefore contributes a `SidebarTab` rather than a bare
 * `UiContribution`, and the sidebar reads the strip out of the region rather
 * than out of a table it maintains. That is the whole point of the migration:
 * `SIDEBAR_TABS` in lib/config.ts and the `PANELS` map next to it are gone, and
 * a fourth tab is a fourth plugin.
 */

import type { PlacedContribution } from '../../lib/plugins/registry.ts';
import type { UiContribution } from '../../lib/plugins/types.ts';

import type { SidebarSnapshot } from './state.ts';

/** Published by the sidebar plugin; empty and inert while it is disabled. */
export const SIDEBAR_TAB_REGION = 'sidebar.tab';

export interface SidebarTab extends UiContribution {
  region: typeof SIDEBAR_TAB_REGION;
  /** The strip's button text. Also names the panel for assistive technology. */
  label: string;
}

/**
 * A tab once the registry has placed it. `PlacedContribution` spreads the
 * contribution it was given, so the label survives the trip.
 */
export interface PlacedSidebarTab extends Omit<PlacedContribution, 'region'>, SidebarTab {}

/** What a tab reports back about itself once it has looked at the document. */
export interface SidebarTabReport {
  /** One line explaining why this tab is empty, or null when it is not. */
  hint?: string | null;
  /** True when the tab cannot work in this browser at all — never restore onto it. */
  blocked?: boolean;
}

/**
 * The sidebar's own surface, reachable by whoever holds the capability.
 *
 * `openViaShortcut` is not `select`: a shortcut is an interruption and has
 * somewhere to go back to, a click is a decision and does not. Both are here
 * because a tab that binds a chord (Search does) has to be able to say which
 * one it meant.
 */
export interface SidebarApi {
  /** Everything the strip and its panels render from. */
  readonly store: { get(): SidebarSnapshot; subscribe(fn: () => void): () => void };

  select(key: string): void;
  openViaShortcut(key: string): void;
  dismiss(): void;
  setExpanded(expanded: boolean): void;
  report(key: string, report: SidebarTabReport): void;
  /** Land on a stored tab, if it still exists and can work. */
  restore(stored: string | null, available: readonly string[]): void;
}

// Declaration merging, as `Capabilities` documents: `use('sidebar')` is typed
// and a typo is a compile error rather than a silent undefined.
declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    sidebar: SidebarApi;
  }
}
