/**
 * The table of contents, as one tab of the sidebar.
 *
 * It contributes to `sidebar.tab` and knows nothing else about where it lands:
 * no `SIDEBAR_TABS` entry, no `PANELS` row, no import of the sidebar's runtime.
 * With the sidebar plugin disabled this contribution is inert — the region was
 * never declared, so nothing renders and nothing complains.
 *
 * `order` is what puts the outline before Files. Import order is not, and must
 * not be: the registry sorts on `order` and breaks ties by registry index, so
 * the strip reads the same whatever the array in lib/plugins/index.ts looks
 * like on any given day.
 */

import type { ComponentType } from 'react';

import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { SIDEBAR_TAB_REGION, type SidebarTab } from '../sidebar/tabs.ts';

export const OUTLINE_PLUGIN_ID = 'outline';

export const OUTLINE_TAB = {
  region: SIDEBAR_TAB_REGION,
  key: 'outline',
  order: 10,
  label: 'Outline',
} as const satisfies Omit<SidebarTab, 'component'>;

export function createOutlinePlugin(component: ComponentType): Plugin {
  return {
    id: OUTLINE_PLUGIN_ID,
    name: 'Outline',
    description: "The document's headings, with scroll-spy and a filter.",
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    // Ordering only: the tab is inert without the sidebar rather than broken,
    // so this is about the strip being built once rather than about behaviour.
    after: ['sidebar'],
    ui: [{ ...OUTLINE_TAB, component }],
  };
}
