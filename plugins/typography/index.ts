/**
 * Typography, as a plugin.
 *
 * What moves is `typographyVars()` in `Viewer.tsx`: the four `--mdv-*` custom
 * properties the shell wrote onto `.mdv` from settings. Keeping them in CSS is
 * the reason a font-size change repaints without React touching the document
 * body at all, and that is unchanged — only the writer moves.
 *
 * They are written to `document.documentElement` rather than to the shell's own
 * element, because a plugin has no element. That is also the right place: the
 * export path and the print stylesheet both read the tokens off the root, and
 * an inline declaration there outranks the `:root` defaults in viewer.css
 * exactly as the shell's inline style outranked them before.
 *
 * ## Why `ctx.global`, not `ctx.settings`
 *
 * Font size and measure are not this plugin's property. The export menu passes
 * them into the generated HTML, the presentation deck scales from them, and
 * reading-time estimates change with them — a plugin-namespaced setting would
 * make every one of those read another plugin's settings, which is the coupling
 * the namespace exists to prevent. Typography *describes the document*, which
 * is the definition of a global. This plugin is the only writer of the CSS
 * properties; it is not the owner of the values.
 *
 * ## The gap this had to work around
 *
 * `ctx.global` is the plugin host's own bag (`StoredSettings.global`), and
 * nothing bridges it to `lib/settings.ts`, where the options page writes and
 * where `DEFAULT_SETTINGS` lives. Read `ctx.global.current` alone today and
 * every reader gets 16px regardless of what they chose. So the resolution
 * order here is: schema defaults, then the viewer's stored settings, then
 * anything the host's global bag overrides — and both sources are subscribed
 * to. When the host's globals become the viewer's settings, the middle layer
 * and its subscription delete cleanly and nothing else here changes.
 */

import {
  CONTENT_WIDTH_CH,
  DEFAULT_SETTINGS,
  FONT_STACKS,
  VIEWER_CSS_VARS,
  type Settings,
} from '../../lib/config.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { loadSettings, onSettingsChanged } from '../../lib/settings.ts';

/**
 * The global settings this plugin owns.
 *
 * Owning is not the same as storing. The values stay in `lib/config.ts`'s
 * `Settings` — see the note above on why typography is a global — but *who
 * configures them* is this plugin, and this array is the statement of that. The
 * options page reads it to decide which rows belong in this plugin's section
 * rather than under a heading of its own, and `entrypoints/options/owned.ts`
 * fails to compile if a key in `Settings` is claimed by nobody.
 *
 * There is no `ownedGlobals` field on `Plugin` to declare it through: that
 * would be a change to `lib/plugins/types.ts`, which is worth doing the next
 * time a third plugin needs one and is not worth widening the public API for
 * two. Until then this export is the declaration, and it lives with the plugin,
 * which is the part that matters.
 */
export const TYPOGRAPHY_GLOBALS = [
  'fontFamily',
  'fontSize',
  'lineHeight',
  'contentWidth',
] as const satisfies readonly (keyof Settings)[];

type Typography = Pick<Settings, (typeof TYPOGRAPHY_GLOBALS)[number]>;

const KEYS = TYPOGRAPHY_GLOBALS;

/** Layered: schema defaults, the viewer's settings, then the host's globals. */
export function resolveTypography(
  stored: Partial<Settings>,
  globals: Readonly<Record<string, unknown>>,
): Typography {
  const out = { ...DEFAULT_SETTINGS, ...stored } as Settings;

  for (const key of KEYS) {
    const override = globals[key];
    if (override === undefined) continue;
    if (typeof override === typeof out[key]) {
      (out as unknown as Record<string, unknown>)[key] = override;
    }
  }

  return out;
}

/**
 * The four declarations, as a plain map. Exported so a test can assert the
 * values without a browser — the same reason the colour arithmetic in
 * `theme-presets.ts` is a function rather than a stylesheet.
 */
export function typographyVars(typography: Typography): Record<string, string> {
  return {
    [VIEWER_CSS_VARS.fontFamily]:
      FONT_STACKS[typography.fontFamily] ?? FONT_STACKS[DEFAULT_SETTINGS.fontFamily],
    [VIEWER_CSS_VARS.fontSize]: `${typography.fontSize}px`,
    [VIEWER_CSS_VARS.lineHeight]: String(typography.lineHeight),
    [VIEWER_CSS_VARS.contentWidth]:
      CONTENT_WIDTH_CH[typography.contentWidth] ??
      CONTENT_WIDTH_CH[DEFAULT_SETTINGS.contentWidth],
  };
}

export const typographyPlugin: Plugin = {
  id: 'typography',
  name: 'Typography',
  description:
    'Applies the reading font, size, line height and measure to the document as CSS custom properties.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  setup(ctx) {
    const root = document.documentElement;
    let stored: Partial<Settings> = {};

    const paint = () => {
      const vars = typographyVars(resolveTypography(stored, ctx.global.current));
      for (const [property, value] of Object.entries(vars)) {
        root.style.setProperty(property, value);
      }
    };

    // Best effort, like every other read of storage in the renderer: a reader
    // who cannot load their settings gets the defaults, never a blank page.
    let disposed = false;
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
    ];

    paint();

    return () => {
      disposed = true;
      for (const off of unsubscribe) off();
      // No residue: the properties fall back to viewer.css's `:root` defaults
      // rather than being frozen at whatever this last wrote.
      for (const property of Object.values(VIEWER_CSS_VARS)) {
        root.style.removeProperty(property);
      }
    };
  },
};
