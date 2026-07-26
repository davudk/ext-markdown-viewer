/**
 * Which plugin owns which global setting.
 *
 * The seven values in `Settings` stay where they are — in `lib/config.ts`, read
 * and written through `lib/settings.ts`. Three things depend on that and none of
 * them can be given up:
 *
 *   - `entrypoints/renderer.tsx` resolves and applies the theme before React
 *     mounts, on every path, including the ones where the theme plugin never
 *     runs. It cannot read a plugin's settings bag for that, because a disabled
 *     or thrown plugin is exactly the case it exists to cover.
 *   - the export plugin matches exported HTML to the reader's typography, and
 *     the command palette toggles the theme. Both read `lib/settings.ts`.
 *   - `settings-io.ts` exports and imports the same seven keys, and
 *     `GLOBAL_SETTING_KEYS` is asserted against `DEFAULT_SETTINGS` by a test.
 *
 * So these really are globals, and they stay global. What was wrong was not
 * where they were stored but where they were *configured*: a page-wide
 * "General" card, three cards away from the Theme plugin whose behaviour it was
 * describing. That is what this map fixes. Each plugin declares the keys it
 * owns (`THEME_GLOBALS`, `TYPOGRAPHY_GLOBALS`, next to the code that applies
 * them); this file pairs each declaration with the panel that renders it, and
 * the panel is rendered inside that plugin's section.
 *
 * The panels live here rather than under `plugins/` because they are made of
 * this page's controls and this page's stylesheet, and a plugin reaching into
 * `entrypoints/options/` for either would be the wrong direction of dependency.
 */

import type { Settings } from '@/lib/settings';
import { THEME_GLOBALS } from '@/plugins/theme';
import { TYPOGRAPHY_GLOBALS } from '@/plugins/typography';

/** Every global claimed by some plugin. */
export type ClaimedGlobal =
  | (typeof THEME_GLOBALS)[number]
  | (typeof TYPOGRAPHY_GLOBALS)[number];

type Unclaimed = Exclude<keyof Settings, ClaimedGlobal>;

/** Fails to satisfy its own constraint when handed `false`. */
type Assert<T extends true> = T;

/**
 * A compile error the moment a setting is added to `Settings` and no plugin
 * claims it — the failure this arrangement is otherwise open to, since an
 * unclaimed global would render nowhere and be silently unreachable rather than
 * loudly missing. Exported so it is not an unused local; nothing reads it.
 */
export type AllGlobalsClaimed = Assert<
  [Unclaimed] extends [never] ? true : false
>;

/** Plugin ids that own globals, in the order their panels appear. */
export const OWNING_PLUGIN_IDS = ['theme', 'typography'] as const;

export const OWNED_GLOBALS: Readonly<
  Record<(typeof OWNING_PLUGIN_IDS)[number], readonly (keyof Settings)[]>
> = {
  theme: THEME_GLOBALS,
  typography: TYPOGRAPHY_GLOBALS,
};

/** Whether this plugin configures globals of its own, for grouping the TOC. */
export function ownsGlobals(pluginId: string): boolean {
  return Object.hasOwn(OWNED_GLOBALS, pluginId);
}
