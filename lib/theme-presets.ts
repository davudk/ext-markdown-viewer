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
  THEME_PRESETS,
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
