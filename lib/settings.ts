/**
 * All state lives in chrome.storage.local. Never storage.sync — that round-trips
 * through Google's servers, which breaks the zero-network guarantee.
 */

export type Theme = 'light' | 'dark' | 'auto';

export interface Settings {
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings>) };
  } catch {
    // Storage can fail in a torn-down context; defaults keep rendering working.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Fires whenever settings change, so an open document restyles immediately. */
export function onSettingsChanged(fn: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local' || !changes[KEY]) return;
    fn({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<Settings>) });
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
