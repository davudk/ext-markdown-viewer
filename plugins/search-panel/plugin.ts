/**
 * Full-document search, as one tab of the sidebar.
 *
 * A thin wrapper: `components/SearchPanel.tsx` stays where it is for now and is
 * migrated on its own, so this is the tab metadata, the chord that opens it,
 * and nothing else.
 *
 * The chord is the interesting half. It used to live in `Sidebar.tsx`, which
 * meant "ctrl/cmd+shift+F only works while the sidebar exists" was a fact about
 * where the listener was written. It is now a fact about capabilities: the
 * shortcut is always bound, and it finds no sidebar to open when the sidebar
 * plugin is disabled. Quick find — a fixed overlay, and a different feature —
 * is what remains either way.
 */

import type { ComponentType } from 'react';

import { SEARCH_ALL_KEY } from '../../lib/config.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { SIDEBAR_TAB_REGION, type SidebarTab } from '../sidebar/tabs.ts';

export const SEARCH_PANEL_PLUGIN_ID = 'search-panel';

export const SEARCH_TAB = {
  region: SIDEBAR_TAB_REGION,
  key: 'search',
  order: 30,
  label: 'Search',
} as const satisfies Omit<SidebarTab, 'component'>;

export function createSearchPanelPlugin(component: ComponentType): Plugin {
  return {
    id: SEARCH_PANEL_PLUGIN_ID,
    name: 'Search panel',
    description: 'Every match in the document, and across an open folder.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    after: ['sidebar'],
    ui: [{ ...SEARCH_TAB, component }],

    setup(ctx) {
      ctx.shortcuts.add({
        key: SEARCH_ALL_KEY,
        // Shift is what separates this from quick find, which owns the
        // unshifted chord and is a different feature rather than a smaller
        // version of this one.
        ctrlOrMeta: true,
        shift: true,
        run: (event) => {
          // The registry matches on key and modifiers only, so the three guards
          // the old window listener applied are applied here instead. Alt is
          // the one that matters: alt+ctrl+shift+F is somebody else's chord.
          if (event.defaultPrevented || event.isComposing || event.altKey) return;

          const sidebar = ctx.capabilities.use('sidebar');
          if (!sidebar) return;

          event.preventDefault();
          sidebar.openViaShortcut(SEARCH_TAB.key);
        },
      });
    },
  };
}
