/**
 * The bridge between `ctx.global` and the viewer's own settings.
 *
 * Theme and typography describe the document rather than any one feature, so
 * several plugins read them and the options page writes them. Before this the
 * host answered `ctx.global` out of its own storage bag, which nothing
 * connected to `lib/settings.ts` — so a plugin reading it got schema defaults
 * while the options page wrote somewhere else. Typography, theme and one other
 * plugin had each grown the same three-layer workaround (defaults → viewer
 * settings → host bag) before anyone noticed they were all papering over the
 * same missing seam.
 *
 * Keeping this out of `lib/settings.ts` is deliberate: that module is imported
 * by the popup and the options page, neither of which has a plugin host.
 */

import {
  loadSettings,
  onSettingsChanged,
  saveSettings,
  type Settings,
} from '../settings.ts';
import type { GlobalSettings, Teardown } from './types.ts';

/**
 * Reads synchronously, which `GlobalSettings.current` requires, so the value is
 * cached and refreshed from the storage subscription. The first read before the
 * initial load resolves returns defaults — correct, and the same frame the
 * renderer already paints with.
 */
export function createGlobalSettings(initial: Settings): GlobalSettings & {
  dispose: Teardown;
} {
  let current: Settings = initial;
  const listeners = new Set<() => void>();

  const unsubscribe = onSettingsChanged((next) => {
    current = next;
    for (const listener of [...listeners]) listener();
  });

  return {
    get current() {
      return current as unknown as Readonly<Record<string, unknown>>;
    },

    async set(patch) {
      // Written through `saveSettings` rather than into a local copy, so the
      // options page and every other context see it by the same route.
      current = await saveSettings(patch as Partial<Settings>);
      for (const listener of [...listeners]) listener();
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    dispose() {
      listeners.clear();
      unsubscribe();
    },
  };
}

/** Convenience for the shell, which has to await the first read anyway. */
export async function loadGlobalSettings() {
  return createGlobalSettings(await loadSettings());
}
