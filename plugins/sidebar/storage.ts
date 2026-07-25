/**
 * Which tab the reader left open.
 *
 * Under its own key rather than in the plugin's settings, and that is a
 * decision rather than an oversight:
 *
 *   - it is where the reader left the UI, not something they chose — plugin
 *     settings are rendered as controls on the options page, and "last open
 *     tab" is not a control anybody wants;
 *   - `updateSettings` bumps the host status store, which re-renders every
 *     contribution of every plugin. Paying that on each tab click to persist a
 *     transient is the wrong trade;
 *   - the value is a tab *key*, and the set of keys is now whatever contributes
 *     to `sidebar.tab`. A settings schema is declared statically on the plugin
 *     object, so it could not enumerate them without knowing the tabs — which
 *     is exactly the coupling this migration removed.
 *
 * The stored value is therefore validated against the tabs that exist right
 * now, in `SidebarState.restore`, rather than against a list in lib/config.ts.
 */

import { SIDEBAR_STATE_KEY } from '../../lib/config.ts';

export async function loadSidebarTab(): Promise<string | null> {
  try {
    const stored = await chrome.storage.local.get(SIDEBAR_STATE_KEY);
    const tab = (stored[SIDEBAR_STATE_KEY] as { tab?: unknown } | undefined)?.tab;
    return typeof tab === 'string' ? tab : null;
  } catch {
    // Same best-effort bargain as everything else: a failed read costs the
    // reader one tab switch.
    return null;
  }
}

export async function saveSidebarTab(tab: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: { tab } });
  } catch {
    // The tab is open on screen either way; only the memory of it is lost.
  }
}
