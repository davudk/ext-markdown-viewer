/**
 * The command palette, as a plugin.
 *
 * This is the one that most needed to stop being special. It used to be a
 * component of the shell taking nine props, four of which were the abilities it
 * offered — export, the raw toggle, comparing files, reaching the options page —
 * and three of which `Viewer.tsx` had nothing to pass. So the palette listed
 * neither "Export as HTML" nor "Compare files…" on any document, ever: the rows
 * existed in `PALETTE_COMMANDS`, `buildCommands` dropped them for want of a
 * handler, and nothing about that was visible from either end.
 *
 * They arrive as capabilities now. `export` and `diff` are provided by the
 * plugins that implement them, `files.browser` by the Files tab, and each row
 * appears exactly while its provider is enabled — which is the same rule as
 * before, said by the thing that knows the answer rather than by a prop that was
 * never filled in. Absence stays a normal state: a palette that drops a row is
 * correct, one that lists an action doing nothing is not.
 *
 * The palette also stops being the place commands are defined. It reads
 * `ctx.commands` like any other reader, so presentation's "Present document" and
 * quick find's "Find in document…" are in the list because their plugins put
 * them there, and it contributes its own the same way.
 *
 * Split from `index.tsx` because `node --experimental-strip-types` refuses a
 * `.tsx` file outright.
 */

import type { ComponentType } from 'react';

import { buildCommands, type PaletteItem } from '../../lib/commands.ts';
/**
 * The command palette's key, held apart from `SHORTCUTS` because it is not one.
 *
 * `SHORTCUTS` is a table of unmodified single keys, and `useKeyboardShortcuts`
 * refuses any event carrying a modifier — putting `k` in there would bind a bare
 * `k` as well, which is a character in every field on the page. This is matched
 * only with ctrl or cmd held, the way every other palette in the world spells it.
 */
export const COMMAND_PALETTE_KEY = 'k';
import { Store } from '../../lib/plugins/registry.ts';
import {
  PLUGIN_API_VERSION,
  type Capabilities,
  type OverlayHandle,
  type Plugin,
} from '../../lib/plugins/types.ts';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  type Settings,
} from '../../lib/settings.ts';

export const PALETTE_PLUGIN_ID = 'command-palette';
export const PALETTE_OVERLAY = 'palette';
export const PALETTE_COMMAND = 'command-palette.open';

/**
 * Switching between the rendered and the raw view.
 *
 * The shell's, not a plugin's — `showRaw` is `Viewer.tsx` state, the same way
 * `document.open` and `document.compare` are — and declared here because the
 * palette is the only thing that needs it. Absent means the row is absent, which
 * is the rule every other row already follows.
 */
declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    'document.toggleRaw': () => void;
  }
}

/**
 * What the palette hands its own overlay.
 *
 * The panel is an overlay component with no parent between it and `setup`, so
 * anything that has to outlive one opening lives here: the viewer's settings
 * (read once and kept current, so the first render's hints are right rather than
 * defaults for a frame) and the restart counter, which is how a second
 * ctrl/cmd+K means "select the query" rather than nothing.
 */
export interface PaletteCapability {
  readonly settings: Store<Settings>;
  readonly restarts: Store<number>;
  open(): void;
}

declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    'command-palette': PaletteCapability;
  }
}

export interface PaletteViews {
  Panel: ComponentType<{ close: () => void }>;
}

export function createCommandPalettePlugin(views: PaletteViews): Plugin {
  return {
    id: PALETTE_PLUGIN_ID,
    name: 'Command palette',
    description: 'Ctrl/Cmd+K: one field over everything the viewer can do or go to.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    // Load order only, and only so the first opening finds their rows already
    // registered rather than one frame later. Nothing here depends on them.
    after: ['export', 'diff', 'files', 'presentation', 'quick-find'],

    setup(ctx) {
      const settings = new Store<Settings>({ ...DEFAULT_SETTINGS });
      const restarts = new Store(0);
      let panel: OverlayHandle | null = null;
      let alive = true;

      void loadSettings().then((loaded) => {
        if (alive) settings.set(loaded);
      });
      const stopSettings = onSettingsChanged((next) => settings.set(next));

      const open = () => {
        if (panel?.isOpen) {
          // Already open: the shortcut means "start again", so the standing
          // query is selected rather than the palette closing under a reader's
          // habit. `openOverlay` is idempotent per id and cannot express that.
          restarts.set(restarts.get() + 1);
          return;
        }

        panel = ctx.ui.openOverlay({
          id: PALETTE_OVERLAY,
          label: 'Command palette',
          component: views.Panel,
          onClose: () => {
            panel = null;
          },
        });
      };

      ctx.capabilities.provide('command-palette', { settings, restarts, open });

      // Contributed rather than special-cased: the palette is in its own list,
      // reachable from anywhere a command is, which is the whole point of it
      // reading `ctx.commands` instead of owning one.
      const stopCommand = ctx.commands.add({
        id: PALETTE_COMMAND,
        title: 'Open the command palette',
        category: 'Palette',
        hint: 'Ctrl K',
        run: open,
      });

      const stopShortcut = ctx.shortcuts.add({
        key: COMMAND_PALETTE_KEY,
        ctrlOrMeta: true,
        // A modified K is never part of what somebody is typing, and the palette
        // is how a reader gets out of a field they are stuck in.
        whileTyping: true,
        run: (event) => {
          event.preventDefault();
          open();
        },
      });

      // Not closed on a raw toggle, unlike quick find and the deck: the palette
      // is how a reader gets back *out* of the raw view.

      return () => {
        alive = false;
        stopShortcut();
        stopCommand();
        stopSettings();
        restarts.set(0);
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Capabilities, as rows                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the palette can offer, and what it therefore lists.
 *
 * Every field after the first two is a capability, and every absent one removes
 * its row. `buildCommands` has always worked that way; what is new is that the
 * answers come from the plugins that would do the work rather than from props
 * `Viewer.tsx` never filled in — which is why "Export as HTML" and "Compare
 * files…" have been in `PALETTE_COMMANDS` since before this was a plugin and
 * have never once appeared in the list.
 *
 * It is a function here rather than inline in the panel for the reason every
 * lifecycle decision in this migration is: `node --experimental-strip-types`
 * refuses a `.tsx` file outright, and "the export rows are absent when the
 * export plugin is disabled" is exactly the kind of rule that should be a test
 * rather than a code review note.
 *
 * The capability types are reached through `Capabilities` rather than imported
 * from `plugins/export` and `plugins/diff`. Declaration merging is what makes
 * that possible, and it is the difference between knowing the shape of a
 * capability and importing the plugin that provides it.
 */
export interface PaletteAbilities {
  settings: Settings;
  applySettings(patch: Partial<Settings>): void;
  /** Which view the reader is in, for the raw row's hint. */
  showRaw: boolean;
  toggleRaw?: Capabilities['document.toggleRaw'];
  exporter?: Capabilities['export'];
  differ?: Capabilities['diff'];
  /** What the Files tab published, or undefined with no Files tab at all. */
  folder?: { supported: boolean; rootName: string | null; choose: () => void };
  /** Defaults to `window.print`; named so a test never opens a print dialog. */
  print?: () => void;
}

export function paletteCommands(abilities: PaletteAbilities): PaletteItem[] {
  const { exporter, differ, folder } = abilities;

  return buildCommands({
    settings: abilities.settings,
    applySettings: abilities.applySettings,
    showRaw: abilities.showRaw,
    toggleRaw: abilities.toggleRaw,
    exportFormats: exporter?.formats,
    exportAs: exporter ? (format) => void exporter.run(format) : undefined,
    print: abilities.print ?? (() => window.print()),
    openFolder: folder?.supported ? folder.choose : undefined,
    // Nothing to compare a document against until a folder is open, so the row
    // is absent rather than opening a picker with one side missing.
    compareFiles: differ && folder?.rootName ? () => differ.choose() : undefined,
  });
}
