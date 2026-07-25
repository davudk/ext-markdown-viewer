/**
 * The folder browser, as one tab of the sidebar.
 *
 * Like the outline it contributes to `sidebar.tab` and is inert without it.
 * Unlike the outline it has something to say to other plugins: whether a folder
 * is open. Search needs that as a change signal, so it is published as a
 * capability rather than passed — the two tabs are siblings in a region, and
 * neither is in a position to hand the other a prop.
 */

import type { ComponentType } from 'react';

import { Store } from '../../lib/plugins/registry.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { SIDEBAR_TAB_REGION, type SidebarTab } from '../sidebar/tabs.ts';

import type { FolderStatus } from './types.ts';

export const FILES_PLUGIN_ID = 'files';

export const FILES_TAB = {
  region: SIDEBAR_TAB_REGION,
  key: 'files',
  order: 20,
  label: 'Files',
} as const satisfies Omit<SidebarTab, 'component'>;

export function createFilesPlugin(component: ComponentType): Plugin {
  return {
    id: FILES_PLUGIN_ID,
    name: 'Files',
    description: 'A tree of the markdown files in a folder the reader picked.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    after: ['sidebar'],
    ui: [{ ...FILES_TAB, component }],

    setup(ctx) {
      // `idle` rather than a probe for the File System Access API: the panel
      // reports what it found the moment it mounts, and asking here would mean
      // touching `window` in a plugin that has not rendered anything yet.
      ctx.capabilities.provide('files.status', new Store<FolderStatus>('idle'));
    },
  };
}
