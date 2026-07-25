/**
 * Reading and writing user settings.
 *
 * All state lives in chrome.storage.local. Never storage.sync — that round-trips
 * through Google's servers, which breaks the zero-network guarantee.
 *
 * The shape and defaults live in `config.ts` and are re-exported here so callers
 * have one import for the whole settings surface.
 */

import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from './config.ts';

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
