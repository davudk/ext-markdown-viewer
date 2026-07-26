/**
 * Themes beyond the built-in pair: named presets, a stylesheet the reader
 * writes, and a per-document pin that overrides both.
 *
 * Three things share this module because they answer one question — what
 * colours and rules apply to *this* document — and answering it means resolving
 * all three together, in a fixed order:
 *
 *   1. the global `theme` setting picks a polarity (light or dark, with `auto`
 *      deferring to the OS),
 *   2. the global `themePreset` setting picks which palette that polarity is
 *      taken from,
 *   3. a per-document pin, if one exists, replaces either or both,
 *   4. the user's own CSS is applied last, over whatever came out.
 *
 * Presets deliberately *compose* with light/dark rather than replacing it.
 * Every preset carries both halves, so `light`, `dark` and `auto` keep meaning
 * exactly what they meant before a preset was chosen; the preset only decides
 * which family the chosen half is drawn from. A preset that carried its own
 * polarity would silently override the setting above it, and a reader who set
 * `dark` would be handed a white page by picking a palette.
 *
 * Colour arithmetic is here rather than in a stylesheet because the contrast
 * guarantee has to be checkable without a browser — see `contrastRatio`, which
 * `test/theme-presets.test.ts` runs over every palette on every test run.
 */

import {
  CUSTOM_CSS_MAX_LENGTH,
  DOCUMENT_THEME_KEY,
  DOCUMENT_THEME_LIMIT,
  THEME_PRESET_IDS,
  THEME_TOKENS,
  VIEWER_THEME_DATASET_KEY,
  type Settings,
  type Theme,
  type ThemePalette,
  type ThemePreset,
  type ThemePresetId,
  type ThemeToken,
} from './config.ts';
import { documentKey } from './document-state.ts';

export type { ThemePalette, ThemePreset, ThemePresetId, ThemeToken };

/** Which half of a preset is in use. `auto` resolves to one of these. */
export type ThemePolarity = 'light' | 'dark';

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

const HEX_RE = /^#([0-9a-f]{6})$/i;

/** Rejects anything that is not an opaque six-digit hex, so contrast is total. */
export function parseHex(colour: string): [number, number, number] | null {
  const match = HEX_RE.exec(colour.trim());
  if (!match) return null;

  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** WCAG 2.x relative luminance. sRGB channel, linearized, then weighted. */
function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: string): number {
  const rgb = parseHex(colour);
  if (!rgb) return 0;

  const [r, g, b] = rgb.map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio, 1 to 21. Both colours must be opaque, which is why the
 * palettes are `#rrggbb` only: a translucent token would make the real ratio
 * depend on what happened to be painted underneath it, and no static check
 * could then say whether a preset is readable.
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG AA for body-size text. */
export const CONTRAST_AA = 4.5;
/** WCAG AAA, the bar the high-contrast preset is held to. */
export const CONTRAST_AAA = 7;

/**
 * Which token is drawn on which, read off `entrypoints/viewer.css`.
 *
 * The pairs matter more than the threshold does: checking every colour against
 * `bg` would pass a palette whose syntax tokens are illegible, because code
 * blocks are painted on `surface`, and diff lines on their own backgrounds.
 */
export const CONTRAST_REQUIREMENTS: ReadonlyArray<{
  fg: ThemeToken;
  bg: ThemeToken;
  what: string;
}> = [
  { fg: 'fg', bg: 'bg', what: 'body text' },
  { fg: 'fg', bg: 'surface', what: 'text on code blocks and table headers' },
  { fg: 'fg', bg: 'surface-alt', what: 'text on striped rows and disclosures' },
  { fg: 'fg', bg: 'selection', what: 'selected text' },
  { fg: 'fg', bg: 'mark-bg', what: 'search highlight' },
  { fg: 'fg-muted', bg: 'bg', what: 'muted text' },
  { fg: 'fg-muted', bg: 'surface', what: 'muted text on a surface' },
  { fg: 'fg-muted', bg: 'surface-alt', what: 'muted text on a striped row' },
  { fg: 'accent', bg: 'bg', what: 'links' },
  { fg: 'accent-hover', bg: 'bg', what: 'links being hovered' },
  { fg: 'visited', bg: 'bg', what: 'visited links' },
  { fg: 'on-accent', bg: 'accent', what: 'the tick in a checked task list' },

  // Syntax tokens are all painted inside a `pre`, which is `surface`.
  { fg: 'tk-keyword', bg: 'surface', what: 'keywords' },
  { fg: 'tk-string', bg: 'surface', what: 'strings' },
  { fg: 'tk-comment', bg: 'surface', what: 'comments' },
  { fg: 'tk-number', bg: 'surface', what: 'numbers and literals' },
  { fg: 'tk-title', bg: 'surface', what: 'function and section names' },
  { fg: 'tk-builtin', bg: 'surface', what: 'built-ins and types' },
  { fg: 'tk-tag', bg: 'surface', what: 'tags and attribute names' },
  { fg: 'tk-meta', bg: 'surface', what: 'preprocessor and meta lines' },
  { fg: 'tk-punct', bg: 'surface', what: 'punctuation and parameters' },

  // Diff lines paint their own background over the block.
  { fg: 'tk-addition', bg: 'tk-addition-bg', what: 'added diff lines' },
  { fg: 'tk-deletion', bg: 'tk-deletion-bg', what: 'removed diff lines' },
];

export interface ContrastFinding {
  fg: ThemeToken;
  bg: ThemeToken;
  what: string;
  ratio: number;
}

/** Every requirement that falls short of `minimum`, with its measured ratio. */
export function checkContrast(
  palette: ThemePalette,
  minimum: number = CONTRAST_AA,
): ContrastFinding[] {
  const findings: ContrastFinding[] = [];

  for (const { fg, bg, what } of CONTRAST_REQUIREMENTS) {
    const ratio = contrastRatio(palette[fg], palette[bg]);
    // Rounded to the precision the figures are quoted at, so a value that reads
    // as 4.50 in a report is not failed by its fourth decimal place.
    if (Math.round(ratio * 100) / 100 < minimum) {
      findings.push({ fg, bg, what, ratio });
    }
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The built-in palettes.
 *
 * Two rules shaped every value here, and neither is taste:
 *
 *   Contrast is a correctness property. Body text, muted text, links and every
 *   syntax token clear WCAG AA (4.5:1) against the surface they are actually
 *   drawn on — the page for prose, `surface` for code blocks, the diff
 *   backgrounds for additions and deletions. `high-contrast` clears AAA (7:1).
 *   The ratios are computed, not judged: `test/theme-presets.test.ts` recomputes
 *   all of them on every run, so a preset added later cannot ship failing.
 *
 *   That is also why the borrowed palettes are not verbatim. Solarized, Nord and
 *   Gruvbox were all designed against a lower bar, and several of their accents
 *   land near 3:1 on their own backgrounds. Hue and character are kept; the
 *   lightness of a failing colour is moved until it passes. Where a family ships
 *   only one polarity (Nord is a dark theme), the other half is built from the
 *   same named palette rather than invented — Nord's own Snow Storm greys.
 *
 * They live here rather than in `lib/config.ts` because they are this module's
 * data: everything that reads them — the resolver below, the picker options,
 * the contrast test — is here too, and `config.ts` had to carry a
 * `ThemePresetId` for the `themePreset` setting either way. The `satisfies`
 * clause is what keeps the two halves honest: every entry must name an id from
 * `THEME_PRESET_IDS`, and the check under the table asserts none is left over.
 */
export const THEME_PRESETS = [
  {
    id: 'default',
    label: 'Default',
    note: "The viewer's own palette.",
    // Mirrors the tokens in entrypoints/viewer.css. Duplicated rather than
    // parsed out of the sheet for the same reason EXPORT_CSS is: the test
    // runner is bare node and cannot import a stylesheet. The duplication is
    // load-bearing in one direction only — these values are what the contrast
    // test actually checks, so the default palette is held to the same bar as
    // every preset instead of being grandfathered in.
    light: {
      bg: '#ffffff',
      surface: '#f6f8fa',
      'surface-alt': '#fafbfc',
      fg: '#1f2328',
      'fg-muted': '#5a636d',
      border: '#d5dbe1',
      'border-strong': '#b6bfc9',
      accent: '#0a53be',
      'accent-hover': '#08409a',
      visited: '#6639ba',
      'on-accent': '#ffffff',
      selection: '#cfe3ff',
      scrollbar: '#c3ccd5',
      'mark-bg': '#fff3c4',
      'tk-keyword': '#b3202c',
      'tk-string': '#0a3069',
      'tk-comment': '#5f6874',
      'tk-number': '#0550ae',
      'tk-title': '#7a3fd0',
      'tk-builtin': '#8a3400',
      'tk-tag': '#0f5c28',
      'tk-meta': '#57606a',
      'tk-punct': '#4a545e',
      'tk-addition': '#0f5c28',
      'tk-addition-bg': '#e6ffec',
      'tk-deletion': '#8a1420',
      'tk-deletion-bg': '#ffebe9',
    },
    dark: {
      bg: '#0d1117',
      surface: '#161b22',
      'surface-alt': '#12171f',
      fg: '#e6edf3',
      'fg-muted': '#9aa4af',
      border: '#30363d',
      'border-strong': '#4a525c',
      accent: '#6cb1ff',
      'accent-hover': '#8cc4ff',
      visited: '#c4a0ff',
      'on-accent': '#0d1117',
      selection: '#2d4f7c',
      scrollbar: '#454d57',
      'mark-bg': '#4a3a12',
      'tk-keyword': '#ff8a80',
      'tk-string': '#a8d5ff',
      'tk-comment': '#9aa4af',
      'tk-number': '#84c5ff',
      'tk-title': '#d7b3ff',
      'tk-builtin': '#ffb070',
      'tk-tag': '#8ceb96',
      'tk-meta': '#a5b1bd',
      'tk-punct': '#c2cbd4',
      'tk-addition': '#8ceb96',
      'tk-addition-bg': '#10251a',
      'tk-deletion': '#ffaba4',
      'tk-deletion-bg': '#2b1416',
    },
  },
  {
    id: 'solarized',
    label: 'Solarized',
    note: 'Warm paper and deep teal, after Ethan Schoonover.',
    light: {
      bg: '#fdf6e3',
      surface: '#f4ecd6',
      'surface-alt': '#f9f2e0',
      fg: '#073642',
      'fg-muted': '#4a5f66',
      border: '#ded5bd',
      'border-strong': '#bcb49e',
      accent: '#1a5f8a',
      'accent-hover': '#124765',
      visited: '#5a4fa8',
      'on-accent': '#fdf6e3',
      selection: '#dee7cf',
      scrollbar: '#c8c0aa',
      'mark-bg': '#f2e2a8',
      'tk-keyword': '#9c1f1c',
      'tk-string': '#1a6b64',
      'tk-comment': '#5a6e73',
      'tk-number': '#1a5f8a',
      'tk-title': '#5a4fa8',
      'tk-builtin': '#8f3510',
      'tk-tag': '#5b6600',
      'tk-meta': '#5c6e74',
      'tk-punct': '#44565c',
      'tk-addition': '#4a5b00',
      'tk-addition-bg': '#e8eccd',
      'tk-deletion': '#9c1f1c',
      'tk-deletion-bg': '#f7e0d8',
    },
    dark: {
      bg: '#002b36',
      surface: '#073642',
      'surface-alt': '#04303b',
      fg: '#e3ddc9',
      'fg-muted': '#a3b0ae',
      border: '#134653',
      'border-strong': '#2c5f6c',
      accent: '#5fb4e5',
      'accent-hover': '#86c9ef',
      visited: '#a9adea',
      'on-accent': '#002b36',
      selection: '#0f4a58',
      scrollbar: '#2f5f6b',
      'mark-bg': '#5a4a12',
      'tk-keyword': '#f5726f',
      'tk-string': '#4fc7bb',
      'tk-comment': '#93a1a1',
      'tk-number': '#5fb4e5',
      'tk-title': '#a9adea',
      'tk-builtin': '#f2803f',
      'tk-tag': '#a4bd28',
      'tk-meta': '#9aa9a8',
      'tk-punct': '#b9c2bd',
      'tk-addition': '#a4bd28',
      'tk-addition-bg': '#123321',
      'tk-deletion': '#f5726f',
      'tk-deletion-bg': '#3a1a1c',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    note: 'Arctic blue-greys. The light half uses Nord’s own Snow Storm.',
    light: {
      bg: '#eceff4',
      surface: '#e2e7ee',
      'surface-alt': '#e8ecf2',
      fg: '#2e3440',
      'fg-muted': '#4c566a',
      border: '#d2d9e3',
      'border-strong': '#aeb8c8',
      accent: '#2b6584',
      'accent-hover': '#1f4d66',
      visited: '#7a4b7d',
      'on-accent': '#eceff4',
      selection: '#d3dbe6',
      scrollbar: '#b9c2d0',
      'mark-bg': '#ecdcb0',
      'tk-keyword': '#58668f',
      'tk-string': '#4a6a3e',
      'tk-comment': '#5b6478',
      'tk-number': '#2b6584',
      'tk-title': '#2f6b7c',
      'tk-builtin': '#8a5320',
      'tk-tag': '#4a6a3e',
      'tk-meta': '#5b6478',
      'tk-punct': '#414c5e',
      'tk-addition': '#3f6a3a',
      'tk-addition-bg': '#dfe9d8',
      'tk-deletion': '#9d3a3a',
      'tk-deletion-bg': '#f0dcdc',
    },
    dark: {
      bg: '#2e3440',
      surface: '#3b4252',
      'surface-alt': '#343b49',
      fg: '#eceff4',
      'fg-muted': '#b5bfd0',
      border: '#434c5e',
      'border-strong': '#5a657c',
      accent: '#88c0d0',
      'accent-hover': '#a3d2df',
      visited: '#c9a3cd',
      'on-accent': '#2e3440',
      selection: '#4c566a',
      scrollbar: '#59637a',
      'mark-bg': '#5c5230',
      'tk-keyword': '#9fb0dd',
      'tk-string': '#a3be8c',
      'tk-comment': '#a4aec0',
      'tk-number': '#c3a5bd',
      'tk-title': '#88c0d0',
      'tk-builtin': '#ebcb8b',
      'tk-tag': '#8fbcbb',
      'tk-meta': '#aab4c6',
      'tk-punct': '#d8dee9',
      'tk-addition': '#a3be8c',
      'tk-addition-bg': '#333f34',
      'tk-deletion': '#e08b86',
      'tk-deletion-bg': '#453236',
    },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    note: 'Retro, low-saturation, high warmth.',
    light: {
      bg: '#fbf1c7',
      surface: '#f2e5bc',
      'surface-alt': '#f7ebc4',
      fg: '#3c3836',
      'fg-muted': '#5c5147',
      border: '#e4d5a8',
      'border-strong': '#bdae87',
      accent: '#076678',
      'accent-hover': '#054b58',
      visited: '#8f3f71',
      'on-accent': '#fbf1c7',
      selection: '#e6dcae',
      scrollbar: '#c8b98f',
      'mark-bg': '#efd88a',
      'tk-keyword': '#9d0006',
      'tk-string': '#5f6300',
      'tk-comment': '#6b6054',
      'tk-number': '#8f3f71',
      'tk-title': '#076678',
      'tk-builtin': '#8f4508',
      'tk-tag': '#3d7151',
      'tk-meta': '#6b6054',
      'tk-punct': '#4a4340',
      'tk-addition': '#4f6a2f',
      'tk-addition-bg': '#e6e6b0',
      'tk-deletion': '#9d0006',
      'tk-deletion-bg': '#f3d9c0',
    },
    dark: {
      bg: '#282828',
      surface: '#32302f',
      'surface-alt': '#2d2b2a',
      fg: '#ebdbb2',
      'fg-muted': '#bdae93',
      border: '#3c3836',
      'border-strong': '#5a524c',
      accent: '#83a598',
      'accent-hover': '#a3c0b4',
      visited: '#d3869b',
      'on-accent': '#282828',
      selection: '#504945',
      scrollbar: '#5a524c',
      'mark-bg': '#5c4a12',
      'tk-keyword': '#fc6857',
      'tk-string': '#b8bb26',
      'tk-comment': '#a89984',
      'tk-number': '#d3869b',
      'tk-title': '#8ec07c',
      'tk-builtin': '#fabd2f',
      'tk-tag': '#83a598',
      'tk-meta': '#bdae93',
      'tk-punct': '#d5c4a1',
      'tk-addition': '#b8bb26',
      'tk-addition-bg': '#2f3320',
      'tk-deletion': '#fb5642',
      'tk-deletion-bg': '#3a2320',
    },
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    note: 'Every colour clears WCAG AAA (7:1). No decorative tints.',
    light: {
      bg: '#ffffff',
      surface: '#f2f2f2',
      'surface-alt': '#f8f8f8',
      fg: '#000000',
      'fg-muted': '#3a3a3a',
      border: '#767676',
      'border-strong': '#3a3a3a',
      accent: '#00459e',
      'accent-hover': '#002d6b',
      visited: '#6b1f8f',
      'on-accent': '#ffffff',
      selection: '#c7dcff',
      scrollbar: '#767676',
      'mark-bg': '#ffe97f',
      'tk-keyword': '#9a0000',
      'tk-string': '#00427a',
      'tk-comment': '#3a3a3a',
      'tk-number': '#00459e',
      'tk-title': '#5c1a8a',
      'tk-builtin': '#7a2a00',
      'tk-tag': '#00521f',
      'tk-meta': '#3a3a3a',
      'tk-punct': '#2b2b2b',
      'tk-addition': '#00521f',
      'tk-addition-bg': '#dcf5e2',
      'tk-deletion': '#8a0000',
      'tk-deletion-bg': '#fde2e0',
    },
    dark: {
      bg: '#000000',
      surface: '#141414',
      'surface-alt': '#0a0a0a',
      fg: '#ffffff',
      'fg-muted': '#cfcfcf',
      border: '#8a8a8a',
      'border-strong': '#cfcfcf',
      accent: '#8ec2ff',
      'accent-hover': '#b6d8ff',
      visited: '#dfa8ff',
      'on-accent': '#000000',
      selection: '#3a4a66',
      scrollbar: '#8a8a8a',
      'mark-bg': '#4f4200',
      'tk-keyword': '#ff9c93',
      'tk-string': '#8fd8ff',
      'tk-comment': '#c4c4c4',
      'tk-number': '#8ec2ff',
      'tk-title': '#e0aeff',
      'tk-builtin': '#ffbe7a',
      'tk-tag': '#7ee59a',
      'tk-meta': '#c4c4c4',
      'tk-punct': '#e0e0e0',
      'tk-addition': '#7ee59a',
      'tk-addition-bg': '#0d1f12',
      'tk-deletion': '#ff9c93',
      'tk-deletion-bg': '#24100f',
    },
  },
] as const satisfies ReadonlyArray<ThemePreset & { id: ThemePresetId }>;


/**
 * The other direction of the `satisfies` above: an id with no palette behind it
 * would otherwise only surface as `getPreset` quietly returning the default.
 */
for (const id of THEME_PRESET_IDS) {
  if (!THEME_PRESETS.some((preset) => preset.id === id)) {
    throw new Error(`Theme preset "${id}" has no palette.`);
  }
}

const DEFAULT_PRESET = THEME_PRESETS[0] as unknown as ThemePreset;

export const PRESET_OPTIONS: ReadonlyArray<{
  value: ThemePresetId;
  label: string;
  note: string;
  /** Three swatch colours for the picker: page, text, link. */
  swatch: { light: string[]; dark: string[] };
}> = THEME_PRESETS.map((preset) => ({
  value: preset.id,
  label: preset.label,
  note: preset.note,
  swatch: {
    light: [preset.light.bg, preset.light.fg, preset.light.accent],
    dark: [preset.dark.bg, preset.dark.fg, preset.dark.accent],
  },
}));

/** Unknown ids resolve to the default rather than throwing — storage outlives code. */
export function getPreset(id: string | undefined | null): ThemePreset {
  return (
    (THEME_PRESETS as unknown as ThemePreset[]).find((preset) => preset.id === id) ??
    DEFAULT_PRESET
  );
}

export function isPresetId(value: unknown): value is ThemePresetId {
  return (
    typeof value === 'string' &&
    THEME_PRESETS.some((preset) => preset.id === value)
  );
}

export function paletteFor(
  id: string | undefined | null,
  polarity: ThemePolarity,
): ThemePalette {
  return getPreset(id)[polarity];
}

/**
 * The one place `auto` is turned into a literal.
 *
 * `prefersDark` is passed in rather than read here so this stays a pure
 * function: the caller in the renderer has a live `matchMedia` list it is
 * already subscribed to, and the options page has its own.
 */
export function resolvePolarity(theme: Theme, prefersDark: boolean): ThemePolarity {
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark ? 'dark' : 'light';
}

/* -------------------------------------------------------------------------- */
/* Per-document pins                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a single document may override. Either half independently: pinning a
 * preset without a polarity is the common case (this one document reads better
 * in Solarized), and pinning a polarity without a preset is the other one (this
 * one document is a screenshot-heavy page that has to stay light).
 */
export interface DocumentTheme {
  theme: Theme | null;
  preset: ThemePresetId | null;
}

export interface DocumentThemeEntry {
  key: string;
  override: DocumentTheme;
  usedAt: number;
}

interface StoredEntry {
  override: DocumentTheme;
  /** Last read *or* write. The recency ordering eviction uses. */
  usedAt: number;
}

type DocumentThemes = Record<string, StoredEntry>;

let lastStamp = 0;

/** Monotonic, for the same reason document-state.ts needs it: ties break the LRU. */
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'auto';
}

/**
 * Rebuild the map from whatever storage handed back, dropping anything
 * malformed. Same bargain as `document-state.ts`: one bad entry, from an older
 * version or a half-finished write, must not cost the whole map.
 */
function sanitizeThemes(value: unknown): DocumentThemes {
  if (typeof value !== 'object' || value === null) return {};

  const out: DocumentThemes = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;

    const { override, usedAt } = entry as Partial<StoredEntry>;
    if (typeof usedAt !== 'number' || !Number.isFinite(usedAt)) continue;
    if (typeof override !== 'object' || override === null) continue;

    const theme = isTheme(override.theme) ? override.theme : null;
    const preset = isPresetId(override.preset) ? override.preset : null;
    // An entry that pins nothing is indistinguishable from no entry, and would
    // occupy a slot in the LRU forever.
    if (theme === null && preset === null) continue;

    out[key] = { override: { theme, preset }, usedAt };
  }
  return out;
}

/** Drop least-recently-used entries until the map fits. */
export function pruneThemesToLimit(
  themes: DocumentThemes,
  limit: number = DOCUMENT_THEME_LIMIT,
): DocumentThemes {
  const keys = Object.keys(themes);
  if (keys.length <= limit) return themes;

  const doomed = keys
    .sort((a, b) => themes[a].usedAt - themes[b].usedAt)
    .slice(0, keys.length - limit);

  for (const key of doomed) delete themes[key];
  return themes;
}

async function readThemes(): Promise<DocumentThemes> {
  try {
    const stored = await chrome.storage.local.get(DOCUMENT_THEME_KEY);
    return sanitizeThemes(stored[DOCUMENT_THEME_KEY]);
  } catch {
    // No chrome, no storage, or a torn-down context. Nothing pinned.
    return {};
  }
}

async function writeThemes(themes: DocumentThemes): Promise<void> {
  try {
    await chrome.storage.local.set({ [DOCUMENT_THEME_KEY]: themes });
  } catch {
    // Losing a pin costs the reader a colour scheme, never the document.
  }
}

/** Passing an override that pins nothing clears the entry instead of storing it. */
export async function setDocumentTheme(
  url: string,
  override: DocumentTheme,
): Promise<void> {
  const themes = await readThemes();
  const key = documentKey(url);

  if (override.theme === null && override.preset === null) {
    if (!(key in themes)) return;
    delete themes[key];
  } else {
    themes[key] = { override, usedAt: stamp() };
  }

  await writeThemes(pruneThemesToLimit(themes));
}

/** Returns null when nothing is pinned, including when storage is broken. */
export async function loadDocumentTheme(url: string): Promise<DocumentTheme | null> {
  const themes = await readThemes();
  const entry = themes[documentKey(url)];
  if (!entry) return null;

  // Opening counts as use, so a document read every day keeps its pin.
  entry.usedAt = stamp();
  await writeThemes(themes);

  return entry.override;
}

export async function clearDocumentTheme(url: string): Promise<void> {
  await setDocumentTheme(url, { theme: null, preset: null });
}

/**
 * Every pin, most recently used first. This is what makes the feature findable
 * again from the options page — a per-file override the reader cannot locate is
 * a document that renders wrong for no visible reason.
 */
export async function listDocumentThemes(): Promise<DocumentThemeEntry[]> {
  const themes = await readThemes();
  return Object.entries(themes)
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.usedAt - a.usedAt);
}

/** Removes the key outright, so "cleared" and "never used" are one state on disk. */
export async function clearAllDocumentThemes(): Promise<void> {
  try {
    await chrome.storage.local.remove(DOCUMENT_THEME_KEY);
  } catch {
    // Best effort, never fatal.
  }
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolvedTheme {
  polarity: ThemePolarity;
  preset: ThemePreset;
  palette: ThemePalette;
  /** True when a per-document pin changed either half of the answer. */
  pinned: boolean;
}

export function resolveTheme(options: {
  settings: Pick<Settings, 'theme' | 'themePreset'>;
  override?: DocumentTheme | null;
  prefersDark?: boolean;
}): ResolvedTheme {
  const { settings, override = null, prefersDark = false } = options;

  const theme = override?.theme ?? settings.theme;
  const presetId = override?.preset ?? settings.themePreset;
  const polarity = resolvePolarity(theme, prefersDark);
  const preset = getPreset(presetId);

  return {
    polarity,
    preset,
    palette: preset[polarity],
    pinned: Boolean(override && (override.theme || override.preset)),
  };
}

/* -------------------------------------------------------------------------- */
/* Emitting a preset                                                           */
/* -------------------------------------------------------------------------- */

/** Ids of the two style elements this module owns, so updates replace rather than stack. */
export const PRESET_STYLE_ID = 'mdv-preset-style';
export const CUSTOM_CSS_STYLE_ID = 'mdv-custom-style';

function declarations(palette: ThemePalette): string {
  return THEME_TOKENS.map((token) => `  --mdv-${token}: ${palette[token]};`).join('\n');
}

/**
 * A preset as a stylesheet, both halves at once.
 *
 * Three details are doing real work here.
 *
 * `@media screen` — viewer.css re-declares the whole token set inside its own
 * `@media print` block to force a light, ink-friendly palette. Anything emitted
 * outside a media query would come later in the cascade and defeat that, so
 * choosing Gruvbox would start printing brown paper. Scoping to `screen` leaves
 * the print palette the last word, which is what it should be.
 *
 * `:root:root` — the same specificity trick, in the other direction: repeating
 * the selector outranks viewer.css's `:root[data-mdv-theme=…]` regardless of
 * which sheet the browser ends up ordering first.
 *
 * Both halves, not just the active one — the renderer flips `data-mdv-theme`
 * when the OS switches or the reader presses `d`, and a sheet carrying only one
 * half would leave the other flip showing the built-in palette for a frame.
 */
export function presetStyleText(preset: ThemePreset): string {
  return [
    '@media screen {',
    `:root:root[data-mdv-theme='light'] {`,
    declarations(preset.light),
    '}',
    `:root:root[data-mdv-theme='dark'] {`,
    declarations(preset.dark),
    '}',
    '}',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* User CSS                                                                    */
/* -------------------------------------------------------------------------- */

export type CssRemovalKind = 'import' | 'remote-url' | 'markup';

export interface CssRemoval {
  kind: CssRemovalKind;
  /** The dropped text, clipped, so the notice can quote what went. */
  text: string;
}

export interface SanitizedCss {
  /** Scoped and ready for a `<style>`. Empty when nothing survived. */
  css: string;
  /** The same rules before scoping. What the tests assert against. */
  rules: string;
  removals: CssRemoval[];
  /** The input was over the cap and was cut at it. */
  truncated: boolean;
  /**
   * Set when the input could not be made safe at all. `css` is then empty and
   * nothing is applied — a stylesheet that tried to break out of its scope is
   * not something to partially honour.
   */
  error: string | null;
}

/** Longest fragment quoted back in a removal notice. */
const REMOVAL_QUOTE_MAX = 60;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > REMOVAL_QUOTE_MAX
    ? `${flat.slice(0, REMOVAL_QUOTE_MAX)}…`
    : flat;
}

const IDENT_CHAR = /[a-z0-9_-]/i;

/** True when `source` has `word` at `index`, not preceded by an identifier char. */
function atKeyword(source: string, index: number, word: string): boolean {
  return source.slice(index, index + word.length).toLowerCase() === word;
}

/**
 * The sanitizer, stated in full, because "trusted-ish" is not "trusted":
 *
 *   1. Over `CUSTOM_CSS_MAX_LENGTH` characters — cut at the cap and reported.
 *   2. NUL and the other C0 control characters are dropped. Tabs and newlines
 *      stay; nothing else in that range has a meaning in CSS, and they are how
 *      a keyword gets smuggled past a naive scan.
 *   3. The scan is a real tokenizer that tracks comments and strings, so an
 *      `@import` inside `/* … *​/` or a `url(` inside `"…"` is neither acted on
 *      nor mistaken for one.
 *   4. `@import` and `@charset` are removed whole, through their `;` or their
 *      balanced block. `@import` is a network request wearing a stylesheet.
 *   5. Every `url()` whose target is not a `data:` URI is removed. That covers
 *      `http(s):`, protocol-relative `//`, `file:`, and anything else — the
 *      viewer promises no requests, and a background image is a request. What
 *      is left behind is an invalid declaration, which the CSS parser discards
 *      on its own; nothing has to be reconstructed. `data:` survives because it
 *      is bytes the user already has.
 *   6. `</` is removed. It has no use in CSS outside a string, and leaving it
 *      would make the stylesheet unsafe to serialize into HTML later — which is
 *      exactly what `lib/export.ts` does with the sheet it emits.
 *   7. Braces must balance. A `}` at depth zero is the one construct that could
 *      close the wrapper below and reach the extension's own UI, so it rejects
 *      the whole stylesheet rather than being repaired. A block left *open* at
 *      the end is closed for the reader, since that is what mid-edit looks like
 *      and the CSS parser would do it anyway.
 *
 * Rejection and removal are both reported. Silently dropping half of what
 * someone typed is how a feature earns a reputation for not working.
 */
export function sanitizeCustomCss(input: string): SanitizedCss {
  const empty: SanitizedCss = {
    css: '',
    rules: '',
    removals: [],
    truncated: false,
    error: null,
  };

  if (typeof input !== 'string' || input.trim() === '') return empty;

  const truncated = input.length > CUSTOM_CSS_MAX_LENGTH;
  // eslint-disable-next-line no-control-regex -- the point is the control chars
  const source = (truncated ? input.slice(0, CUSTOM_CSS_MAX_LENGTH) : input).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );

  const removals: CssRemoval[] = [];
  let out = '';
  let depth = 0;
  let index = 0;

  /** Copy a comment or string through verbatim; returns the index after it. */
  const passThrough = (from: number, terminator: string, escapes: boolean): number => {
    let i = from + terminator.length;
    while (i < source.length) {
      if (escapes && source[i] === '\\') {
        i += 2;
        continue;
      }
      if (source.startsWith(terminator, i)) {
        i += terminator.length;
        break;
      }
      // An unterminated string ends at the newline, as CSS says it does.
      if (escapes && source[i] === '\n') break;
      i += 1;
    }
    out += source.slice(from, Math.min(i, source.length));
    return Math.min(i, source.length);
  };

  /** Skip past an at-rule: to the end of its `;` or of its balanced block. */
  const skipAtRule = (from: number): number => {
    let i = from;
    let braces = 0;
    while (i < source.length) {
      const char = source[i];
      if (char === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        i += 1;
        while (i < source.length && source[i] !== char && source[i] !== '\n') {
          i += source[i] === '\\' ? 2 : 1;
        }
        i += 1;
        continue;
      }
      if (char === '{') braces += 1;
      if (char === '}') {
        braces -= 1;
        if (braces <= 0) return i + 1;
      }
      if (char === ';' && braces === 0) return i + 1;
      i += 1;
    }
    return source.length;
  };

  while (index < source.length) {
    const char = source[index];

    if (char === '/' && source[index + 1] === '*') {
      index = passThrough(index, '*/', false);
      continue;
    }

    if (char === '"' || char === "'") {
      index = passThrough(index, char, true);
      continue;
    }

    if (char === '<' && source[index + 1] === '/') {
      removals.push({ kind: 'markup', text: '</' });
      index += 2;
      continue;
    }

    if (char === '@') {
      const isImport = atKeyword(source, index, '@import');
      const isCharset = atKeyword(source, index, '@charset');
      if (isImport || isCharset) {
        const end = skipAtRule(index);
        removals.push({
          kind: 'import',
          text: quote(source.slice(index, end)),
        });
        index = end;
        continue;
      }
    }

    // `url(` — but not `myurl(`, and not the `url` in an identifier.
    if (
      (char === 'u' || char === 'U') &&
      atKeyword(source, index, 'url(') &&
      !(index > 0 && IDENT_CHAR.test(source[index - 1]))
    ) {
      let i = index + 4;
      let target = '';
      let quoteChar = '';

      while (i < source.length) {
        const c = source[i];
        if (quoteChar) {
          if (c === '\\') {
            target += source.slice(i, i + 2);
            i += 2;
            continue;
          }
          if (c === quoteChar) {
            quoteChar = '';
            i += 1;
            continue;
          }
          target += c;
          i += 1;
          continue;
        }
        if (c === '"' || c === "'") {
          quoteChar = c;
          i += 1;
          continue;
        }
        if (c === ')') {
          i += 1;
          break;
        }
        target += c;
        i += 1;
      }

      const literal = source.slice(index, i);
      if (/^data:/i.test(target.trim())) {
        out += literal;
      } else {
        removals.push({ kind: 'remote-url', text: quote(literal) });
      }
      index = i;
      continue;
    }

    if (char === '{') depth += 1;

    if (char === '}') {
      depth -= 1;
      if (depth < 0) {
        return {
          css: '',
          rules: '',
          removals,
          truncated,
          error:
            'There is a stray `}` that closes more than it opens. Nothing was applied — a stylesheet that closes past its own outermost block could reach the rest of the extension.',
        };
      }
    }

    out += char;
    index += 1;
  }

  // Left open mid-edit. The parser would close it at the end of the file; doing
  // it here keeps the wrapper below balanced too.
  const rules = out.trimEnd() + '}'.repeat(Math.max(0, depth));

  return {
    css: rules.trim() === '' ? '' : scopeCustomCss(rules),
    rules,
    removals,
    truncated,
    error: null,
  };
}

/**
 * Wraps sanitized rules so they cannot reach anything but a rendered document.
 *
 * Two layers, because scoping is the other half of the safety story:
 *
 *   `.mdv-body` — the document column, and nothing else. The table of contents,
 *   the toolbar and the search panel all live outside it, so user CSS cannot
 *   hide or reposition the viewer's own controls. The popup and the options
 *   page are separate documents this sheet is never injected into at all, which
 *   is the structural half of the same guarantee.
 *
 *   `#mdv-root` — raises specificity to (1,1,·) so a plain `p { … }` from the
 *   reader beats viewer.css's own `.mdv-body p` without needing `!important`.
 *
 * The rules go *inside* the selector as CSS nesting, so `h1 { … }` means "an h1
 * in the document" and a top-level `color: …` styles the column itself. Nesting
 * is also what makes the brace-balance check above sufficient: with the rules
 * inside a block, escaping the scope requires an unbalanced `}`, and there is
 * no unbalanced `}` left by the time this runs.
 */
export function scopeCustomCss(rules: string): string {
  return `@media screen {\n#mdv-root .mdv-body {\n${rules}\n}\n}\n`;
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                    */
/* -------------------------------------------------------------------------- */

function upsertStyle(doc: Document, id: string, css: string): void {
  const existing = doc.getElementById(id);

  if (css === '') {
    existing?.remove();
    return;
  }

  const style = existing ?? doc.createElement('style');
  if (!existing) {
    style.id = id;
    (doc.head ?? doc.documentElement).append(style);
  }
  // textContent, never innerHTML: the sheet is user-authored text and must not
  // be parsed as markup on the way in.
  if (style.textContent !== css) style.textContent = css;
}

/**
 * Put a resolved theme and the reader's stylesheet onto a document.
 *
 * Idempotent and cheap to call again: both style elements are keyed by id and
 * rewritten only when their text actually changes, so a settings subscription
 * can call this on every change without churning the cascade.
 */
export function applyDocumentTheme(
  doc: Document,
  options: {
    settings: Pick<Settings, 'theme' | 'themePreset' | 'customCss'>;
    override?: DocumentTheme | null;
    prefersDark?: boolean;
  },
): { resolved: ResolvedTheme; css: SanitizedCss } {
  const resolved = resolveTheme(options);
  const css = sanitizeCustomCss(options.settings.customCss ?? '');

  doc.documentElement.dataset[VIEWER_THEME_DATASET_KEY] = resolved.polarity;
  upsertStyle(doc, PRESET_STYLE_ID, presetStyleText(resolved.preset));
  upsertStyle(doc, CUSTOM_CSS_STYLE_ID, css.css);

  return { resolved, css };
}
