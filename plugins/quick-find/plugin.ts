/**
 * Quick find, as a plugin.
 *
 * The panel used to own the question "am I open": a piece of state, a ref the
 * window listener read it through, that listener, two key bindings inside it, an
 * Escape branch, and the focus it captured on the way in and gave back on the
 * way out. All of that is the host's now — the panel is mounted exactly while it
 * is showing, and this file decides when that is.
 *
 * Two things it does that the overlay API does not cover, both deliberate and
 * both reported rather than patched into `lib/plugins`:
 *
 *   · **Re-pressing the shortcut.** `openOverlay` is idempotent per id, which is
 *     the right default — a key held down must not stack five panels. But
 *     ctrl/cmd+F pressed while the panel is up means "start a new search", not
 *     "do nothing", so the second press bumps a counter the panel watches and
 *     selects its query on.
 *   · **`initialFocus`.** The host focuses the first focusable descendant, which
 *     happens to be the query field. That is luck rather than intent: it is the
 *     first control in the bar, and it would stop being true the day a button is
 *     added before it. The counter above covers the selecting either way.
 *
 * Split from `index.tsx`, and taking its panel as an argument, because
 * `node --experimental-strip-types` refuses a `.tsx` file outright.
 */

import type { ComponentType } from 'react';

import { SHORTCUTS } from '../../lib/config.ts';
import { Store } from '../../lib/plugins/registry.ts';
import { PLUGIN_API_VERSION, type OverlayHandle, type Plugin } from '../../lib/plugins/types.ts';

export const QUICK_FIND_PLUGIN_ID = 'quick-find';
export const QUICK_FIND_OVERLAY = 'panel';
export const QUICK_FIND_COMMAND = 'quick-find.open';

/**
 * What quick find offers other plugins, which is only "open yourself".
 *
 * `restarts` is the counter above. It is on the capability rather than in a
 * module-scope variable because the panel is a separate overlay component with
 * no parent between it and `setup`, and a module-scope store is the pattern this
 * whole migration is removing.
 */
export interface QuickFindCapability {
  /** Bumped every time the reader asks for the panel while it is already up. */
  readonly restarts: Store<number>;
  open(): void;
}

declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    'quick-find': QuickFindCapability;
  }
}

export interface QuickFindViews {
  Panel: ComponentType<{ close: () => void }>;
}

export function createQuickFindPlugin(views: QuickFindViews): Plugin {
  return {
    id: QUICK_FIND_PLUGIN_ID,
    name: 'Quick find',
    description: 'Ctrl/Cmd+F: find in the document, grouped by section.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,

    setup(ctx) {
      const restarts = new Store(0);
      let panel: OverlayHandle | null = null;

      const open = () => {
        // The raw view has none of the structure the section grouping is built
        // from, and the shell used to say so by not mounting the panel at all.
        if (ctx.document.isRaw) return;

        if (panel?.isOpen) {
          // Already open: the shortcut means "start again", so the standing
          // query is selected rather than the panel closing under a reader who
          // pressed the key out of habit.
          restarts.set(restarts.get() + 1);
          return;
        }

        panel = ctx.ui.openOverlay({
          id: QUICK_FIND_OVERLAY,
          label: 'Find in document',
          component: views.Panel,
          onClose: () => {
            panel = null;
          },
        });
      };

      ctx.capabilities.provide('quick-find', { restarts, open });

      const stopCommand = ctx.commands.add({
        id: QUICK_FIND_COMMAND,
        title: 'Find in document…',
        category: 'Find',
        hint: 'Ctrl F',
        run: open,
      });

      const stopFind = ctx.shortcuts.add({
        key: 'f',
        ctrlOrMeta: true,
        // From anywhere, including a field the reader is typing in: the takeover
        // of the browser's own find bar is only honest if it is unconditional,
        // and a modified F is never part of what somebody is typing.
        whileTyping: true,
        run: (event) => {
          event.preventDefault();
          open();
        },
      });

      // `/` is a bare key, so the registry's own "not while typing" rule is
      // exactly right for it — stealing it inside a field would make the search
      // box impossible to type a path into. Shift+ctrl/cmd+F belongs to the
      // sidebar's Search tab and is left alone here, as it always was.
      const stopSlash = ctx.shortcuts.add({
        key: SHORTCUTS.search,
        run: (event) => {
          event.preventDefault();
          open();
        },
      });

      // Switching to the raw view takes the panel down with it: the ranges it
      // painted are over nodes that no longer exist.
      const stopWatching = ctx.document.onChange(() => {
        if (ctx.document.isRaw) panel?.close();
      });

      return () => {
        stopWatching();
        stopSlash();
        stopFind();
        stopCommand();
        restarts.set(0);
      };
    },
  };
}
