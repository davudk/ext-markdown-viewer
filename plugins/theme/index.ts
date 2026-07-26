/**
 * Theme, as a plugin: polarity, preset palette, the reader's own CSS, and the
 * per-document pin that overrides the first two.
 *
 * ## What this plugin does NOT own: the first paint
 *
 * `entrypoints/renderer.tsx` resolves and applies the theme *before* it mounts
 * React, and it must keep doing so. A plugin's `setup` runs when the host
 * starts, which is early — but "early" is not the guarantee that matters here.
 * The guarantee is that `data-mdv-theme` and the preset stylesheet are on the
 * document before `reveal()` un-hides it, on every path, including the ones
 * where this plugin never runs at all: a reader who disabled it, a `setup` that
 * threw and was disabled by the host, and the catch block that puts the raw
 * text back after a failed render. Hand the first paint to a plugin and each of
 * those becomes a document that flashes the built-in palette, or keeps it.
 *
 * So the split is:
 *
 *   renderer — one resolve and one `applyDocumentTheme`, before mount. The
 *              baseline every path gets.
 *   plugin   — everything reactive afterwards: a settings change, the OS
 *              flipping to dark, and re-resolving the pin when the document
 *              changes under the tab (the files plugin opens a document whose
 *              URL is not the page's, and pins are keyed by URL).
 *
 * The two agree because they call the same idempotent function, keyed by style
 * element id — the renderer's apply and this one's first apply produce
 * byte-identical text and the second is a no-op on the cascade.
 *
 * Disabling this plugin removes the preset and custom-CSS stylesheets and the
 * polarity attribute, returning the document to viewer.css's built-in palette.
 * That is the honest reading of "no residue", and it is also what a reader who
 * turns the theming off is asking for.
 */

import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import {
  DEFAULT_SETTINGS,
  VIEWER_THEME_DATASET_KEY,
  type Settings,
} from '../../lib/config.ts';
import { loadSettings, onSettingsChanged } from '../../lib/settings.ts';
import {
  CUSTOM_CSS_STYLE_ID,
  PRESET_STYLE_ID,
  applyDocumentTheme,
  loadDocumentTheme,
  type DocumentTheme,
} from '../../lib/theme-presets.ts';

type ThemeSettings = Pick<Settings, 'theme' | 'themePreset' | 'customCss'>;

/**
 * Same layering as the typography plugin, and for the same reason: `ctx.global`
 * is the host's own bag and nothing yet bridges it to `lib/settings.ts`, where
 * the options page writes. Defaults, then stored settings, then globals.
 */
export function resolveThemeSettings(
  stored: Partial<Settings>,
  globals: Readonly<Record<string, unknown>>,
): ThemeSettings {
  const out = { ...DEFAULT_SETTINGS, ...stored } as Settings;

  for (const key of ['theme', 'themePreset', 'customCss'] as const) {
    const override = globals[key];
    if (typeof override === 'string') {
      (out as unknown as Record<string, unknown>)[key] = override;
    }
  }

  return out;
}

export const themePlugin: Plugin = {
  id: 'theme',
  name: 'Theme',
  description:
    'Light and dark, the preset palettes, your own stylesheet, and the per-document pin that overrides them.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  setup(ctx) {
    let stored: Partial<Settings> = {};
    let override: DocumentTheme | null = null;
    /** Which URL `override` was loaded for, so a re-render does not re-read it. */
    let pinnedFor: string | null = null;
    let disposed = false;

    const darkQuery =
      typeof matchMedia === 'function'
        ? matchMedia('(prefers-color-scheme: dark)')
        : null;

    const paint = () => {
      if (disposed) return;
      applyDocumentTheme(document, {
        settings: resolveThemeSettings(stored, ctx.global.current),
        override,
        prefersDark: darkQuery?.matches ?? false,
      });
    };

    /**
     * Re-resolve the pin when the document changes.
     *
     * Keyed on the URL rather than run on every change: the shared document
     * bumps on every render, and a storage read per render would be a read per
     * keystroke of live reload.
     */
    const syncPin = () => {
      const url = ctx.document.url;
      if (url === '' || url === pinnedFor) return;
      pinnedFor = url;

      void loadDocumentTheme(url).then((next) => {
        // A newer document won the race; its own load will paint.
        if (disposed || pinnedFor !== url) return;
        override = next;
        paint();
      });
    };

    void loadSettings().then((next) => {
      if (disposed) return;
      stored = next;
      paint();
    });

    const unsubscribe = [
      onSettingsChanged((next) => {
        stored = next;
        paint();
      }),
      ctx.global.onChange(paint),
      ctx.document.onChange(syncPin),
    ];

    // Only observable while the theme is 'auto', but subscribing
    // unconditionally avoids adding and removing the listener as it changes.
    darkQuery?.addEventListener('change', paint);

    syncPin();
    paint();

    return () => {
      disposed = true;
      for (const off of unsubscribe) off();
      darkQuery?.removeEventListener('change', paint);

      for (const id of [PRESET_STYLE_ID, CUSTOM_CSS_STYLE_ID]) {
        document.getElementById(id)?.remove();
      }
      delete document.documentElement.dataset[VIEWER_THEME_DATASET_KEY];
    };
  },
};
