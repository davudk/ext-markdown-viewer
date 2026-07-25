/**
 * The sidebar, as a plugin that publishes a region rather than fills one.
 *
 * It owns the single `<nav>`, the collapse toggle and the tab strip; what goes
 * in the tabs is `sidebar.tab`, which exists exactly while this plugin is
 * enabled. Disable it and the outline, files and search contributions become
 * inert — nothing renders, nothing throws — which is the honest behaviour when
 * a reader turns the sidebar off, and it falls out of the region model rather
 * than needing a case anywhere.
 *
 * The nav lands in `shell.aside`: the shell's own leading column, published by
 * the shell because it follows from its layout (`entrypoints/viewer.css` gives
 * `.mdv-with-toc > nav` its flex track). Naming it after the *place* rather
 * than after the sidebar is what keeps the shell from knowing this plugin
 * exists.
 *
 * Split from `index.tsx` on purpose: the bare test runner cannot load a `.tsx`
 * file at all, so everything except the component lives here and the component
 * is a parameter. The test then exercises the real plugin object — the real id,
 * the real regions, the real setup — with a stand-in for the one part it
 * physically cannot import.
 */

import type { ComponentType } from 'react';

import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

import { SidebarState } from './state.ts';
import { saveSidebarTab } from './storage.ts';
import { SIDEBAR_TAB_REGION } from './tabs.ts';

export const SIDEBAR_PLUGIN_ID = 'sidebar';

/** The shell's leading column. A string, like every other region reference. */
export const SHELL_ASIDE_REGION = 'shell.aside';

export function createSidebarPlugin(component: ComponentType): Plugin {
  return {
    id: SIDEBAR_PLUGIN_ID,
    name: 'Sidebar',
    description:
      'A column beside the document holding the outline, the folder browser and search.',
    apiVersion: PLUGIN_API_VERSION,
    // Replaces the old `showToc` setting: whether the sidebar exists is now one
    // concept — this plugin's enabled state — rather than a setting and a
    // plugin that could disagree.
    enabledByDefault: true,

    provides: [SIDEBAR_TAB_REGION],

    ui: [{ region: SHELL_ASIDE_REGION, key: 'nav', component }],

    setup(ctx) {
      // The state is the capability. A plugin has nowhere else to keep state
      // that both `setup` and its own contributions can see, and publishing it
      // is also what lets Search's chord reach the tab strip without either
      // plugin importing the other's runtime.
      const state = new SidebarState((tab) => void saveSidebarTab(tab));
      ctx.capabilities.provide('sidebar', state);
    },
  };
}
