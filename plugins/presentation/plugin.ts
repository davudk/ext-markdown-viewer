/**
 * Presentation mode, as a plugin.
 *
 * The second pilot, and the first to use the overlay path, a shortcut and a
 * region contribution. What used to be a `<Presentation html split enabled>`
 * block in the shell — with its own portal, focus trap, scroll lock, `inert`
 * handling and z-index — is now: one overlay opened through the host, one
 * launcher contributed to a corner region, one key binding, one setting.
 *
 * The lifecycle lives here rather than in the component because it outlives it:
 * the fullscreen request has to happen inside the click that opened the deck,
 * and the fullscreen it owns has to be given back however the deck closes —
 * Escape, the exit button, losing fullscreen, a raw toggle, or the reader
 * disabling the plugin entirely.
 *
 * Split from `index.tsx` — and taking its two views as arguments — for one
 * reason: `node --experimental-strip-types` refuses a `.tsx` file outright, so
 * a plugin whose module graph reaches JSX cannot be unit tested at all. This
 * seam keeps every lifecycle decision above in a file the test runner can load.
 */

import type { ComponentType } from 'react';

import {
  PLUGIN_API_VERSION,
  type OverlayHandle,
  type Plugin,
  type Teardown,
} from '../../lib/plugins/types.ts';

/** The key that opens the deck. Unmodified, like every other viewer shortcut. */
const PRESENT_KEY = 'p';

/**
 * How the launcher reaches the deck.
 *
 * A UI contribution is a plain component with no props and no channel back to
 * its plugin's `setup`, so the closure holding the open deck and the fullscreen
 * it owns is not reachable from the button that opens it. A command is: it is
 * registered once here and found by id there. The command palette gets the
 * action for free, which is where it belonged anyway.
 */
export const PRESENT_COMMAND = 'presentation.start';

/**
 * Where slides are cut. The options live here rather than in `lib/config.ts`
 * because the setting describes this feature and nothing else — that is the
 * whole point of a per-plugin schema.
 *
 * `rule` is the convention every markdown presenter already uses — Marp,
 * reveal.js, remark, Deckset and Pandoc all cut on `---` — and it is the only
 * one that is *authored*. Heading splitting is a heuristic imposed on a
 * document that was never written as a deck, which is why neither is the
 * default: almost no README carries a single `---`, and presenting one as a
 * wall of text is worse than cutting at its section headings.
 */
const settings = {
  slideSplit: {
    type: 'enum',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'rule', label: 'Horizontal rules' },
      { value: 'heading', label: 'Headings' },
    ],
    label: 'Slide breaks',
    description:
      'Cut slides on horizontal rules, on headings, or whichever the document has.',
  },
} as const;

/**
 * The schema, as a type. `SettingsOf` turns it into
 * `{ slideSplit: 'auto' | 'rule' | 'heading' }`, and the deck hands that
 * straight to `splitSlides` — so an option value drifting from `SlideSplit` is
 * a compile error at the call site rather than a mode nothing implements.
 */
export type PresentationSettings = typeof settings;

export interface PresentationViews {
  /** The corner button. Rendered by the host into `chrome.bottom-end`. */
  Launcher: ComponentType;
  /** The deck itself. Rendered by the host inside its managed overlay. */
  Deck: ComponentType<{ close: () => void }>;
}

export function createPresentationPlugin(
  views: PresentationViews,
): Plugin<PresentationSettings> {
  return {
    id: 'presentation',
    name: 'Presentation mode',
    description: 'Shows the document one slide at a time, full screen.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    settings,

    ui: [
      {
        // Named for where it is, not for what it is: the shell publishes the
        // corner and never learns that a presentation button lives in it.
        region: 'chrome.bottom-end',
        key: 'launcher',
        component: views.Launcher,
      },
    ],

    setup(ctx) {
      /** The open deck, or null. One at a time, by construction. */
      let deck: OverlayHandle | null = null;
      /** Whether *we* put the page into fullscreen, and therefore owe it an exit. */
      let ownsFullscreen = false;
      let watchFullscreen: Teardown | null = null;

      const releaseFullscreen = () => {
        watchFullscreen?.();
        watchFullscreen = null;

        if (ownsFullscreen && document.fullscreenElement) {
          void document.exitFullscreen().catch(() => {});
        }
        ownsFullscreen = false;
      };

      const requestFullscreen = () => {
        // Requested on the document element rather than on the overlay, which
        // does not exist yet at this point in the click — and waiting a render
        // for it would spend the user activation the Fullscreen API insists on.
        // Failure is survivable by construction: the deck is a fixed
        // full-viewport surface either way, so a rejection costs nothing but
        // the browser chrome staying up.
        if (document.fullscreenElement || !document.documentElement.requestFullscreen) {
          return;
        }

        void document.documentElement.requestFullscreen().then(
          () => {
            ownsFullscreen = true;
            // The browser answers a frame or two later, and the deck can be
            // gone by then — closed, or the plugin disabled under it. The exit
            // we owe does not depend on that timing.
            if (!deck?.isOpen) releaseFullscreen();
          },
          () => {
            ownsFullscreen = false;
          },
        );

        // Escape while the page is in fullscreen is consumed by the browser and
        // never reaches a keydown handler, so losing fullscreen *is* the exit
        // signal — as it is for F11 and for the "exit full screen" chip.
        const onFullscreenChange = () => {
          if (ownsFullscreen && !document.fullscreenElement) deck?.close();
        };
        document.addEventListener('fullscreenchange', onFullscreenChange);
        watchFullscreen = () =>
          document.removeEventListener('fullscreenchange', onFullscreenChange);
      };

      const start = () => {
        // The launcher cannot be clicked while the deck is up — the host inerts
        // the shell beneath a modal — but the shortcut still fires, and a
        // second deck stacked on the first is nobody's intent.
        if (deck?.isOpen) return;
        if (ctx.document.isRaw) return;

        deck = ctx.ui.openOverlay({
          id: 'presentation',
          label: 'Presentation',
          component: views.Deck,
          // Every close path arrives here: Escape, the exit button, losing
          // fullscreen, a raw toggle, and the host closing our overlays when
          // the plugin is disabled.
          onClose: () => {
            deck = null;
            releaseFullscreen();
          },
        });

        requestFullscreen();
      };

      const stopCommand = ctx.commands.add({
        id: PRESENT_COMMAND,
        title: 'Present document',
        category: 'Presentation',
        hint: PRESENT_KEY.toUpperCase(),
        run: start,
      });

      const stopShortcut = ctx.shortcuts.add({
        key: PRESENT_KEY,
        run: (event) => {
          // The host's registry matches keys and modifiers and nothing else, so
          // the "not while they are typing" rule the viewer's own shortcuts
          // have is restated here — a bare `p` that opens a deck mid-word in
          // the search box is a bug, not a shortcut.
          if (isTypingTarget(event.target) || event.isComposing) return;
          event.preventDefault();
          start();
        },
      });

      // Switching to the raw view has to take the deck down with it rather than
      // leaving an overlay over a document that is no longer there.
      const stopWatching = ctx.document.onChange(() => {
        if (ctx.document.isRaw) deck?.close();
      });

      return () => {
        stopWatching();
        stopShortcut();
        stopCommand();
        // The host closes our overlays before running this, so the deck is
        // already gone and `onClose` has already released fullscreen. Called
        // again in case setup is ever unwound without one — it is idempotent.
        releaseFullscreen();
      };
    },
  };
}

/**
 * Whether a keystroke belongs to whatever the reader is typing into.
 *
 * A local copy of the shell's own rule: `lib/hooks.ts` keeps its version
 * private, and the host's `ShortcutRegistry` has none.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase());
}
