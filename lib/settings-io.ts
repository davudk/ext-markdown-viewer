/**
 * Settings as a file: one JSON document out, and one back in.
 *
 * Export is uninteresting — the settings object is already plain data, so it is
 * stamped with a format marker and a version and written to disk.
 *
 * Import is the whole point of this module. The file came from the user, but
 * "the user chose it" is not the same as "the user wrote it": it may be an
 * unrelated .json, a file hand-edited past what the sliders allow, one written
 * by a build from the future, or one crafted to make the extension write
 * something it would never write itself. So nothing here trusts the parse.
 *
 * The rule that does most of the work is that a parsed blob is never spread
 * into settings. Import walks `FIELD_READERS` — a table keyed by the settings
 * this build knows about — and asks each one for its own field. A key that is
 * not in that table cannot reach storage no matter what it is called, which is
 * what makes `__proto__` and `constructor` non-events rather than special
 * cases: they are simply not settings, so they are reported and dropped along
 * with any other stray key.
 *
 * Everything up to the final `saveSettings` is pure and synchronous, so a file
 * that fails validation changes nothing at all — the write is never reached.
 */

import {
  CONTENT_WIDTH_OPTIONS,
  CUSTOM_CSS_MAX_LENGTH,
  DEFAULT_SETTINGS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  SETTINGS_FILE_BASENAME,
  SETTINGS_FILE_FORMAT,
  SETTINGS_FILE_VERSION,
  SLIDE_SPLIT_OPTIONS,
  THEME_OPTIONS,
  THEME_PRESETS,
  type ContentWidth,
  type FontFamily,
  type Settings,
  type SlideSplit,
  type Theme,
  type ThemePresetId,
} from './config.ts';
import { saveSettings } from './settings.ts';

/* -------------------------------------------------------------------------- */
/* The file                                                                    */
/* -------------------------------------------------------------------------- */

export interface SettingsFile {
  format: string;
  version: number;
  /** Informational only. Never read back — a timestamp is not a setting. */
  exportedAt: string;
  settings: Settings;
}

export function buildSettingsFile(
  settings: Settings,
  now: Date = new Date(),
): SettingsFile {
  return {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    exportedAt: now.toISOString(),
    // Rebuilt field by field rather than copied, so a stray key that reached
    // storage in some earlier version cannot be laundered back out as ours.
    settings: pickKnown(settings),
  };
}

/** Indented on purpose: the file is meant to be readable and hand-editable. */
export function serializeSettings(settings: Settings, now?: Date): string {
  return `${JSON.stringify(buildSettingsFile(settings, now), null, 2)}\n`;
}

/** `markdown-viewer-settings-2026-07-25.json`. Sorts usefully in a downloads folder. */
export function settingsFilename(now: Date = new Date()): string {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `${SETTINGS_FILE_BASENAME}-${date}.json`;
}

/* -------------------------------------------------------------------------- */
/* Field readers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns the value to use, or `undefined` to mean "not usable, keep the
 * default". Never throws: a reader that threw would let one bad field decide
 * the fate of a file that is otherwise fine.
 */
type FieldReader<K extends keyof Settings> = (value: unknown) => Settings[K] | undefined;

function oneOf<T extends string>(
  allowed: readonly { value: T }[],
): (value: unknown) => T | undefined {
  const values = new Set<string>(allowed.map((option) => option.value));
  return (value: unknown) =>
    typeof value === 'string' && values.has(value) ? (value as T) : undefined;
}

function boolean(value: unknown): boolean | undefined {
  // Deliberately not truthiness: `"false"` and `0` are what a hand-edited file
  // contains when someone meant off, and guessing which is worse than refusing.
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * A number the sliders produce, clamped rather than rejected.
 *
 * Clamping is the right answer for a range: a file asking for a 400px body font
 * is out of bounds, not incomprehensible, and silently reverting to 16 would be
 * more surprising than landing on the largest size the extension offers. A
 * value that is not a finite number at all is a different thing and is dropped.
 */
function ranged(
  range: { min: number; max: number },
  decimals: number,
): (value: unknown) => number | undefined {
  return (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const clamped = Math.min(range.max, Math.max(range.min, value));
    const factor = 10 ** decimals;
    return Math.round(clamped * factor) / factor;
  };
}

function cappedText(limit: number): (value: unknown) => string | undefined {
  return (value: unknown) =>
    typeof value === 'string' ? value.slice(0, limit) : undefined;
}

const PRESET_IDS = new Set<string>(THEME_PRESETS.map((preset) => preset.id));

/**
 * The known settings, and how each one is read out of an untrusted object.
 *
 * This table is the schema. `test/settings-io.test.ts` asserts it covers
 * `DEFAULT_SETTINGS` exactly, so adding a setting without teaching import about
 * it fails the build rather than producing a file that quietly loses it.
 */
const FIELD_READERS: { [K in keyof Settings]: FieldReader<K> } = {
  theme: oneOf<Theme>(THEME_OPTIONS),
  themePreset: (value) =>
    typeof value === 'string' && PRESET_IDS.has(value)
      ? (value as ThemePresetId)
      : undefined,
  customCss: cappedText(CUSTOM_CSS_MAX_LENGTH),
  fontFamily: oneOf<FontFamily>(FONT_FAMILY_OPTIONS),
  fontSize: ranged(FONT_SIZE_RANGE, 0),
  lineHeight: ranged(LINE_HEIGHT_RANGE, 2),
  contentWidth: oneOf<ContentWidth>(CONTENT_WIDTH_OPTIONS),
  showToc: boolean,
  liveReload: boolean,
  rememberScroll: boolean,
  mermaid: boolean,
  math: boolean,
  lightbox: boolean,
  externalLinks: boolean,
  presentation: boolean,
  slideSplit: oneOf<SlideSplit>(SLIDE_SPLIT_OPTIONS),
  readingStats: boolean,
  readingProgress: boolean,
  headingFold: boolean,
};

const KNOWN_KEYS = Object.keys(FIELD_READERS) as (keyof Settings)[];

/** A settings object rebuilt from known keys only. */
function pickKnown(source: Settings): Settings {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of KNOWN_KEYS) {
    if (Object.hasOwn(source, key)) {
      const value = FIELD_READERS[key](source[key]);
      if (value !== undefined) (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Import                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImportOk {
  ok: true;
  settings: Settings;
  /**
   * Everything that was not taken at face value: fields clamped, fields
   * ignored, keys that are not settings. Always surfaced — an import that
   * silently discarded half the file is how a reader ends up with settings they
   * did not choose and cannot explain.
   */
  notes: string[];
  /** True when the file names a format version this build does not know. */
  fromFuture: boolean;
}

export interface ImportError {
  ok: false;
  error: string;
}

export type ImportResult = ImportOk | ImportError;

/** Refuses a file large enough to be something other than a settings export. */
export const IMPORT_MAX_BYTES = 256 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(items: string[], limit = 6): string {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/**
 * Validate a settings file. Pure: it reads nothing and writes nothing, so a
 * caller can show the result before committing to it.
 */
export function parseSettingsFile(text: string): ImportResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'That file is empty.' };
  }

  if (text.length > IMPORT_MAX_BYTES) {
    return {
      ok: false,
      error: `That file is larger than ${Math.round(IMPORT_MAX_BYTES / 1024)} KB, which a settings file never is. Nothing was changed.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "That file isn't valid JSON, so none of it could be read. Nothing was changed.",
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: "That file isn't a Markdown Viewer settings file — it doesn't contain a settings object. Nothing was changed.",
    };
  }

  // The format marker is checked before anything else so that pointing the
  // picker at an unrelated .json says so, rather than producing a list of
  // complaints about fields that were never meant to be there.
  if (parsed.format !== SETTINGS_FILE_FORMAT) {
    return {
      ok: false,
      error: "That isn't a Markdown Viewer settings file. Nothing was changed.",
    };
  }

  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      error: 'That settings file has no usable version number, so it cannot be read safely. Nothing was changed.',
    };
  }

  if (!isPlainObject(parsed.settings)) {
    return {
      ok: false,
      error: 'That settings file has no settings in it. Nothing was changed.',
    };
  }

  const source = parsed.settings;
  const settings = { ...DEFAULT_SETTINGS };
  const notes: string[] = [];
  const ignored: string[] = [];
  const adjusted: string[] = [];
  const missing: string[] = [];

  for (const key of KNOWN_KEYS) {
    // `hasOwn`, not `in`: `in` walks the prototype chain, and a file is exactly
    // the place a prototype gets tampered with.
    if (!Object.hasOwn(source, key)) {
      missing.push(key);
      continue;
    }

    const raw = source[key];
    const value = FIELD_READERS[key](raw);

    if (value === undefined) {
      ignored.push(key);
      continue;
    }

    if (typeof value === 'number' && value !== raw) adjusted.push(key);
    if (typeof value === 'string' && value !== raw) adjusted.push(key);
    (settings as Record<string, unknown>)[key] = value;
  }

  // Anything that is not one of ours. `__proto__` and friends land here with
  // every other stray key, because the loop above never looked them up.
  const known = new Set<string>(KNOWN_KEYS);
  const unknown = Object.keys(source).filter((key) => !known.has(key));

  const fromFuture = version > SETTINGS_FILE_VERSION;
  if (fromFuture) {
    notes.push(
      `This file was written by a newer version of the extension (format ${version}). Everything this version understands was imported; the rest was left out.`,
    );
  }

  if (unknown.length > 0) {
    notes.push(
      unknown.length === 1
        ? `Ignored one entry that isn't a setting: ${list(unknown)}.`
        : `Ignored ${unknown.length} entries that aren't settings: ${list(unknown)}.`,
    );
  }
  if (ignored.length > 0) {
    notes.push(`Left at the default because the value was the wrong kind: ${list(ignored)}.`);
  }
  if (adjusted.length > 0) {
    notes.push(`Brought back into the allowed range: ${list(adjusted)}.`);
  }
  // Only worth saying for a file from this version; a future one is expected to
  // disagree about which settings exist, and already said so above.
  if (missing.length > 0 && !fromFuture) {
    notes.push(`Not in the file, so left as they were set here: ${list(missing)}.`);
  }

  return { ok: true, settings, notes, fromFuture };
}

/**
 * Validate, then write. The write only happens on a fully validated object, so
 * "the import failed" and "settings are unchanged" are the same statement.
 */
export async function importSettings(text: string): Promise<ImportResult> {
  const result = parseSettingsFile(text);
  if (!result.ok) return result;

  await saveSettings(result.settings);
  return result;
}

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The same two-path download `lib/export.ts` performs, restated rather than
 * shared, because the two run in different worlds and the reasoning differs.
 * Export runs in a content script, where `chrome.downloads` is absent and the
 * anchor is the path that normally fires; this runs on the options page, where
 * `chrome.downloads` is present and the anchor is the fallback. Reaching into
 * export.ts for a private helper would couple a settings feature to the
 * document exporter for eight lines.
 */
const REVOKE_DELAY_MS = 60_000;

interface DownloadsApi {
  download: (
    options: { url: string; filename: string; saveAs?: boolean },
    callback?: (id?: number) => void,
  ) => void;
}

interface ChromeLike {
  downloads?: Partial<DownloadsApi>;
  runtime?: { lastError?: unknown };
}

function chromeApi(): ChromeLike | undefined {
  return (globalThis as { chrome?: ChromeLike }).chrome;
}

function downloadViaChrome(url: string, filename: string): Promise<boolean> {
  const api = chromeApi();
  const downloads = api?.downloads;
  if (typeof downloads?.download !== 'function') return Promise.resolve(false);

  return new Promise((resolve) => {
    try {
      // `saveAs: true`: unlike a document export, this is a file the reader is
      // going to have to find again later to import it somewhere else.
      (downloads as DownloadsApi).download({ url, filename, saveAs: true }, (id) => {
        // Read inside the callback, or Chrome logs it as an unchecked error.
        resolve(api?.runtime?.lastError === undefined && id !== undefined);
      });
    } catch {
      resolve(false);
    }
  });
}

function downloadViaAnchor(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';

  document.body.append(link);
  link.click();
  link.remove();
}

/** Writes the current settings to a file. Returns the name it was saved under. */
export async function exportSettings(
  settings: Settings,
  now?: Date,
): Promise<{ filename: string }> {
  const filename = settingsFilename(now);
  const blob = new Blob([serializeSettings(settings, now)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);

  try {
    if (!(await downloadViaChrome(url, filename))) downloadViaAnchor(url, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }

  return { filename };
}
