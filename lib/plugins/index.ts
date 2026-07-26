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

import { codeCopyPlugin } from '@/plugins/code-copy';
import { commandPalettePlugin } from '@/plugins/command-palette';
import { diffPlugin } from '@/plugins/diff';
import { exportPlugin } from '@/plugins/export';
import { externalLinksPlugin } from '@/plugins/external-links';
import { filesPlugin } from '@/plugins/files';
import { headingAnchorsPlugin } from '@/plugins/heading-anchors';
import { headingFoldPlugin } from '@/plugins/heading-fold';
import { lightboxPlugin } from '@/plugins/lightbox';
import { liveReloadPlugin } from '@/plugins/live-reload';
import { markdownContainersPlugin } from '@/plugins/markdown-containers';
import { markdownEmojiPlugin } from '@/plugins/markdown-emoji';
import { markdownFootnotesPlugin } from '@/plugins/markdown-footnotes';
import { markdownGithubAlertsPlugin } from '@/plugins/markdown-github-alerts';
import { markdownHeadingsPlugin } from '@/plugins/markdown-headings';
import { markdownMathPlugin } from '@/plugins/markdown-math';
import { markdownMermaidPlugin } from '@/plugins/markdown-mermaid';
import { markdownTablesPlugin } from '@/plugins/markdown-tables';
import { markdownWikilinksPlugin } from '@/plugins/markdown-wikilinks';
import { outlinePlugin } from '@/plugins/outline';
import { presentationPlugin } from '@/plugins/presentation';
import { quickFindPlugin } from '@/plugins/quick-find';
import { readingStatusPlugin } from '@/plugins/reading-status';
import { scrollMemoryPlugin } from '@/plugins/scroll-memory';
import { searchPanelPlugin } from '@/plugins/search-panel';
import { sidebarPlugin } from '@/plugins/sidebar';
import { themePlugin } from '@/plugins/theme';
import { typographyPlugin } from '@/plugins/typography';

import type { AnyPlugin } from './types.ts';

import type { CompareRequest } from '@/lib/diff';
import type { OpenedDocument } from '@/plugins/files/types';

/**
 * The array is load order, never render order: what a contribution renders
 * before or after is its `order`, and the sidebar's tabs read the same however
 * this list is sorted.
 */
export const PLUGINS: readonly AnyPlugin[] = [
  // Appearance first: both write to the document before anything reads it.
  themePlugin,
  typographyPlugin,

  // The markdown pipeline. Order here is documentation, not a requirement —
  // each rule is positioned against a markdown-it rule name rather than against
  // another plugin, and `test/markdown-order.test.ts` renders the whole set
  // reversed and shuffled to prove the output is byte-identical.
  markdownFootnotesPlugin,
  markdownEmojiPlugin,
  markdownTablesPlugin,
  markdownGithubAlertsPlugin,
  markdownContainersPlugin,
  markdownMathPlugin,
  markdownMermaidPlugin,
  markdownWikilinksPlugin,
  markdownHeadingsPlugin,

  // Passes over the rendered document.
  externalLinksPlugin,
  codeCopyPlugin,
  headingAnchorsPlugin,
  headingFoldPlugin,
  readingStatusPlugin,

  // The sidebar publishes `sidebar.tab`; the three below fill it. A tab
  // contributed while the sidebar is disabled is inert, not an error.
  sidebarPlugin,
  outlinePlugin,
  filesPlugin,
  searchPanelPlugin,

  // Surfaces. The palette reads the others through capabilities, so it loads
  // after them and simply drops a row for anything absent.
  lightboxPlugin,
  presentationPlugin,
  exportPlugin,
  diffPlugin,
  quickFindPlugin,
  commandPalettePlugin,

  // Behaviours with no UI of their own.
  scrollMemoryPlugin,
  liveReloadPlugin,
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
