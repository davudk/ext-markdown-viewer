/**
 * The plugin registry.
 *
 * One array, in load order. Adding a feature is an entry here plus a folder
 * under `plugins/` — not an edit to the shell, the settings page and the
 * sidebar, which is what it used to cost.
 *
 * Migration is deliberately incremental: features not yet listed here are still
 * hand-wired in `components/Viewer.tsx`, and each one moves across in its own
 * commit with `npm run verify` green either side.
 */

import { externalLinksPlugin } from '@/plugins/external-links';
import { filesPlugin } from '@/plugins/files';
import { outlinePlugin } from '@/plugins/outline';
import { presentationPlugin } from '@/plugins/presentation';
import { searchPanelPlugin } from '@/plugins/search-panel';
import { sidebarPlugin } from '@/plugins/sidebar';

import type { AnyPlugin } from './types.ts';

import type { CompareRequest } from '@/lib/diff';
import type { OpenedDocument } from '@/plugins/files/types';

/**
 * The array is load order, never render order: what a contribution renders
 * before or after is its `order`, and the sidebar's tabs read the same however
 * this list is sorted.
 */
export const PLUGINS: readonly AnyPlugin[] = [
  externalLinksPlugin,
  presentationPlugin,
  sidebarPlugin,
  outlinePlugin,
  filesPlugin,
  searchPanelPlugin,
];

/**
 * What the shell can do on a plugin's behalf.
 *
 * Both of these are the shell's, not a plugin's: opening a file read through a
 * directory handle swaps the rendered document, and comparing two files opens
 * the diff overlay — state that lives in `Viewer.tsx`. The shell is not a
 * plugin and has no `PluginContext`, so it publishes them straight onto the
 * host's capability store; a plugin uses them exactly like any other, and both
 * are legitimately absent before the shell has mounted.
 */
declare module './types.ts' {
  interface Capabilities {
    'document.open': (document: OpenedDocument) => void;
    'document.compare': (request: CompareRequest) => void;
  }
}

export { PluginHost, type HostStorage } from './host.ts';
export { SharedDocument } from './document.ts';
export { PLUGIN_SETTINGS_KEY, type StoredSettings } from './settings.ts';
export * from './react.tsx';
export * from './types.ts';

/**
 * Plugin settings live under their own storage key rather than inside the
 * viewer's `settings` object: they are keyed by plugin id and validated by the
 * registry, and mixing them in would put a second schema into a shape that
 * already has one.
 */
export function chromeStorage(): import('./host.ts').HostStorage {
  return {
    async read() {
      try {
        const stored = await chrome.storage.local.get('pluginSettings');
        return stored.pluginSettings;
      } catch {
        // Defaults are a working extension; a failed read must not be fatal.
        return null;
      }
    },
    async write(value) {
      try {
        await chrome.storage.local.set({ pluginSettings: value });
      } catch {
        // The change is already live in memory; only its persistence is lost.
      }
    },
  };
}
