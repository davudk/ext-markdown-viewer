/**
 * Reading and writing user settings.
 *
 * All state lives in chrome.storage.local. Never storage.sync — that round-trips
 * through Google's servers, which breaks the zero-network guarantee.
 *
 * The shape and defaults live in `config.ts` and are re-exported here so callers
 * have one import for the whole settings surface.
 */

import {
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_TAB,
  SETTINGS_KEY,
  SIDEBAR_STATE_KEY,
  SIDEBAR_TABS,
  type Settings,
  type SidebarTabId,
} from './config.ts';

export { DEFAULT_SETTINGS, THEME_OPTIONS } from './config.ts';
export type { Settings, Theme } from './config.ts';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings>) };
  } catch {
    // Storage can fail in a torn-down context; defaults keep rendering working.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Fires whenever settings change, so an open document restyles immediately.
 *
 * Subscribing is best-effort for the same reason reading is: this runs inside
 * the renderer, which has already replaced the page content by the time it is
 * called. A missing or torn-down `chrome.storage` must cost the reader live
 * theme updates, never the document itself.
 */
export function onSettingsChanged(fn: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    fn({
      ...DEFAULT_SETTINGS,
      ...(changes[SETTINGS_KEY].newValue as Partial<Settings>),
    });
  };

  try {
    chrome.storage.onChanged.addListener(listener);
  } catch {
    return () => {};
  }

  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      // The context is already gone; there is nothing left to detach from.
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which sidebar tab was last open.
 *
 * Under its own key rather than inside `Settings`: it is where the reader left
 * the UI, not something they chose on the options page, and mixing the two
 * would put a transient into the object every settings listener re-renders on.
 * Same best-effort bargain as everything else here — a failed read costs the
 * reader one tab switch.
 */
export async function loadSidebarTab(): Promise<SidebarTabId> {
  try {
    const stored = await chrome.storage.local.get(SIDEBAR_STATE_KEY);
    const tab = (stored[SIDEBAR_STATE_KEY] as { tab?: unknown } | undefined)?.tab;
    return SIDEBAR_TABS.some((entry) => entry.id === tab)
      ? (tab as SidebarTabId)
      : DEFAULT_SIDEBAR_TAB;
  } catch {
    return DEFAULT_SIDEBAR_TAB;
  }
}

export async function saveSidebarTab(tab: SidebarTabId): Promise<void> {
  try {
    await chrome.storage.local.set({ [SIDEBAR_STATE_KEY]: { tab } });
  } catch {
    // The tab is open on screen either way; only the memory of it is lost.
  }
}
