/**
 * Document comparison, as a plugin.
 *
 * Three things used to be tangled here and are now separate: *who asks* for a
 * comparison, *what is being compared*, and *what is on screen*.
 *
 *   · The asking is a capability. `document.compare` was published by the shell
 *     — `Viewer.tsx` held a `compare` state and rendered `<Diff request={…}>` —
 *     which meant the feature could not be disabled and its overlay could not be
 *     nested. It is published here now, by the plugin that actually implements
 *     it, so disabling the plugin withdraws the ability rather than leaving the
 *     Files tab raising a menu nothing will answer.
 *   · The subject is one `Store`, read by every view.
 *   · What is on screen is two managed overlays. Everything that used to make
 *     this modal by hand — the portal onto `document.body`, `inert` on
 *     `#mdv-root`, the `focusin` backstop, the Tab trap, the Escape handler, the
 *     focus restore and two `z-index: 2147483000` — is the host's, and is gone
 *     from this feature entirely.
 *
 * The one thing that could not move is the scroll lock: the old overlay set
 * `documentElement.style.overflow = 'hidden'` while it was up, and the host has
 * no equivalent. See `lockScroll` below.
 *
 * Split from `index.tsx`, and taking its views as arguments, because
 * `node --experimental-strip-types` refuses a `.tsx` file outright — so a plugin
 * whose module graph reaches JSX cannot be unit tested at all.
 */

import type { ComponentType } from 'react';

import type { CompareRequest } from '../../lib/diff.ts';
import { Store } from '../../lib/plugins/registry.ts';
import {
  PLUGIN_API_VERSION,
  type OverlayHandle,
  type Plugin,
} from '../../lib/plugins/types.ts';

/* -------------------------------------------------------------------------- */
/* How the two files are shown                                                 */
/* -------------------------------------------------------------------------- */

/*
 * Read by `Diff.tsx` and nothing else, so they are the diff plugin's data
 * rather than the extension's. They sit in this file and not in the component
 * because the bare test runner cannot load a `.tsx`.
 */

/** How the source diff lays the two files out. */
export type DiffLayout = 'split' | 'unified';

/** Which representation of the two files is compared. */
export type DiffMode = 'source' | 'rendered';

/**
 * Split source is the default because it is the only combination that answers
 * both questions at once — what changed, and what the line now says — without
 * the reader reconstructing one from the other. Unified is for narrow windows
 * and long lines; rendered is for prose, where the markup is the noise.
 */
export const DEFAULT_DIFF_MODE: DiffMode = 'source';
export const DEFAULT_DIFF_LAYOUT: DiffLayout = 'split';

export const DIFF_MODE_OPTIONS: ReadonlyArray<{ value: DiffMode; label: string }> = [
  { value: 'source', label: 'Source' },
  { value: 'rendered', label: 'Rendered' },
];

export const DIFF_LAYOUT_OPTIONS: ReadonlyArray<{ value: DiffLayout; label: string }> = [
  { value: 'split', label: 'Split' },
  { value: 'unified', label: 'Unified' },
];

export const DIFF_PLUGIN_ID = 'diff';

/** Overlay ids. Stable, because `openOverlay` is idempotent per id. */
export const DIFF_MENU_OVERLAY = 'menu';
export const DIFF_PICKER_OVERLAY = 'picker';
export const DIFF_VIEW_OVERLAY = 'view';

/**
 * What comparing two documents looks like from outside.
 *
 * `target` is a `Store` rather than a value for the reason every capability
 * holding live state is: the capability's identity only changes when it is
 * provided or withdrawn, and this changes — a new file is pointed at, the
 * comparison is closed — while the plugin stays enabled.
 */
export interface DiffCapability {
  /** The file being compared against, or null. */
  readonly target: Store<CompareRequest | null>;
  /** Offer to compare the open document against a file. Raises the row menu. */
  compare(request: CompareRequest): void;
  /** Show the comparison for the standing target. */
  start(): void;
  /** Pick a file out of the open folder and compare against it. */
  choose(): void;
}

declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    diff: DiffCapability;
  }
}

export interface DiffViews {
  /** The row menu: one item, "compare with current file". */
  Menu: ComponentType<{ close: () => void }>;
  /** A list of the open folder's files, for a comparison started from a command. */
  Picker: ComponentType<{ close: () => void }>;
  /** The comparison itself. */
  View: ComponentType<{ close: () => void }>;
}

export function createDiffPlugin(views: DiffViews): Plugin {
  return {
    id: DIFF_PLUGIN_ID,
    name: 'Compare documents',
    description: 'Shows what changed between the open document and another file.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    // Load order only: the row menu is raised *by* the Files tab, but this
    // plugin works perfectly well without it — a comparison can also be started
    // from the palette, and with neither there is simply nothing to compare.
    after: ['files'],

    setup(ctx) {
      const target = new Store<CompareRequest | null>(null);

      /** The overlay currently up, whichever it is. One at a time. */
      let showing: OverlayHandle | null = null;
      let unlockScroll: (() => void) | null = null;

      /**
       * Shows one of our surfaces, replacing whichever is up.
       *
       * `generation` is what tells a hand-off from a dismissal apart. The menu
       * closes and the comparison opens in the same call, and the closing one's
       * `onClose` must not then clear the target the opening one is about to
       * read — so the check is deferred by a microtask and skipped if anything
       * has been shown since. Without it a second right-click, which is also a
       * close followed by an open, wiped its own request.
       */
      let generation = 0;

      const put = (id: string, component: ComponentType<{ close: () => void }>) => {
        showing?.close();

        const mine = ++generation;
        showing = ctx.ui.openOverlay({
          id,
          label: 'Compare documents',
          component,
          onClose: () => {
            if (generation !== mine) return;
            showing = null;
            queueMicrotask(() => {
              if (generation !== mine) return;
              target.set(null);
              unlockScroll?.();
              unlockScroll = null;
            });
          },
        });
      };

      const capability: DiffCapability = {
        target,

        compare(request) {
          target.set(request);
          put(DIFF_MENU_OVERLAY, views.Menu);
        },

        start() {
          if (!target.get()) return;
          lockScroll();
          put(DIFF_VIEW_OVERLAY, views.View);
        },

        choose() {
          put(DIFF_PICKER_OVERLAY, views.Picker);
        },
      };

      /**
       * The one thing the overlay host does not do.
       *
       * A full-screen comparison that lets the page behind it scroll leaves the
       * reader's place in the document somewhere else when they close it, and
       * the old implementation stopped that with an inline `overflow: hidden` on
       * `<html>`. `OverlayOptions` has no equivalent, so it is restated here —
       * locally, and reported rather than patched into `lib/plugins`, because
       * every modal overlay wants this and the fix belongs in the host.
       */
      const lockScroll = () => {
        if (unlockScroll || typeof document === 'undefined') return;
        const html = document.documentElement;
        const previous = html.style.overflow;
        html.style.overflow = 'hidden';
        unlockScroll = () => {
          html.style.overflow = previous;
        };
      };

      ctx.capabilities.provide('diff', capability);
      // Replaces the shell's own `document.compare`, which `Viewer.tsx`
      // published while the diff was hand-wired into it. Same name, same shape;
      // the Files tab does not learn that anything moved.
      ctx.capabilities.provide('document.compare', (request) =>
        capability.compare(request),
      );

      // No command is registered here, for the same reason the export plugin
      // registers none: `PALETTE_COMMANDS` already has a `compare-files` entry,
      // with its title and its keywords, that has never had anything behind it.
      // The palette builds that row the moment this capability appears, so a
      // command of our own would be the same action listed twice.

      // A comparison is against the document that was on screen when it opened.
      // Live reload or the raw toggle replacing that document under it would
      // leave two panes of text that no longer describe anything.
      const stopWatching = ctx.document.onChange(() => showing?.close());

      return () => {
        stopWatching();
        // The host closes our overlays before this runs, so `onClose` has
        // already cleared the target and released the scroll lock. Called again
        // in case setup is ever unwound without one — both are idempotent.
        target.set(null);
        unlockScroll?.();
        unlockScroll = null;
      };
    },
  };
}
