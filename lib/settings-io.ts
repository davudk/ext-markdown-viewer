/**
 * Settings as a file: one JSON document out, and one back in.
 *
 * Export is uninteresting — settings are already plain data, so they are
 * stamped with a format marker and a version and written to disk.
 *
 * Import is the whole point of this module. The file came from the user, but
 * "the user chose it" is not the same as "the user wrote it": it may be an
 * unrelated .json, a file hand-edited past what the sliders allow, one written
 * by a build from the future, or one crafted to make the extension write
 * something it would never write itself. So nothing here trusts the parse.
 *
 * The rule that does most of the work is that a parsed blob is never spread.
 * Every value is looked up by a key this build already knows and read by
 * something that decides what that key may contain. A key that is not one of
 * ours cannot reach storage no matter what it is called, which is what makes
 * `__proto__` and `constructor` non-events rather than special cases: they are
 * simply not settings, so they are reported and dropped with any other stray key.
 *
 * There are two halves, and neither is a hand-maintained list of features:
 *
 *   · the **global** settings — theme and typography — validated against
 *     `FIELD_READERS`, which covers `Settings` exactly and no more;
 *   · every **plugin's** own settings, validated against that plugin's declared
 *     schema through the same `coerce` the plugin host uses at runtime.
 *
 * The schemas arrive as an argument rather than by importing the registry: the
 * registry's module graph reaches JSX, which the bare test runner cannot load,
 * and a validator that has to be edited whenever a plugin is added is the thing
 * this replaced. A caller that passes no schemas validates the global half and
 * reports every plugin in the file as unrecognised, which is the honest answer.
 *
 * Everything up to the final write is pure and synchronous, so a file that
 * fails validation changes nothing at all — the write is never reached.
 */

import {
  CONTENT_WIDTH_OPTIONS,
  CUSTOM_CSS_MAX_LENGTH,
  DEFAULT_SETTINGS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_RANGE,
  GLOBAL_SETTING_KEYS,
  LINE_HEIGHT_RANGE,
  SETTINGS_FILE_BASENAME,
  SETTINGS_FILE_FORMAT,
  SETTINGS_FILE_VERSION,
  THEME_OPTIONS,
  THEME_PRESET_IDS,
  type ContentWidth,
  type FontFamily,
  type Settings,
  type Theme,
  type ThemePresetId,
} from './config.ts';
import {
  coerce,
  PLUGIN_SETTINGS_KEY,
  PLUGIN_SETTINGS_VERSION,
  type StoredSettings,
} from './plugins/settings.ts';
import type { SettingDefinition, SettingsSchema } from './plugins/types.ts';
import { saveSettings } from './settings.ts';

/* -------------------------------------------------------------------------- */
/* The file                                                                    */
/* -------------------------------------------------------------------------- */

/** The plugin half of a file: one bag per plugin id, exactly as it is stored. */
export type PluginBags = StoredSettings['plugins'];

export interface SettingsFile {
  format: string;
  version: number;
  /** Informational only. Never read back — a timestamp is not a setting. */
  exportedAt: string;
  settings: Settings;
  /**
   * Present only when there is something to say. An older file has no `plugins`
   * at all, and one that named none would be indistinguishable from a file
   * asking for every plugin to be reset.
   */
  plugins?: PluginBags;
}

export function buildSettingsFile(
  settings: Settings,
  now: Date = new Date(),
  plugins?: PluginBags,
): SettingsFile {
  const file: SettingsFile = {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    exportedAt: now.toISOString(),
    // Rebuilt field by field rather than copied, so a stray key that reached
    // storage in some earlier version cannot be laundered back out as ours.
    settings: pickKnown(settings),
  };

  // Written verbatim: unlike `settings`, the shape here is whatever the plugins
  // that are installed declare, and this module has no schema to rebuild it
  // from. It is checked on the way back *in*, where the schemas are known.
  if (plugins && Object.keys(plugins).length > 0) file.plugins = plugins;

  return file;
}

/** Indented on purpose: the file is meant to be readable and hand-editable. */
export function serializeSettings(
  settings: Settings,
  now?: Date,
  plugins?: PluginBags,
): string {
  return `${JSON.stringify(buildSettingsFile(settings, now, plugins), null, 2)}\n`;
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

const PRESET_IDS = new Set<string>(THEME_PRESET_IDS);

/**
 * The global settings, and how each one is read out of an untrusted object.
 *
 * Short, and it stays short: this covers `Settings` and nothing else, so it
 * grows only when the *shared* settings do. A feature's own knobs are not here
 * — they are its plugin's schema, validated below by the same rules the host
 * applies at runtime, which is what lets a plugin be added without this file
 * being touched.
 *
 * `test/settings-io.test.ts` asserts the table covers `DEFAULT_SETTINGS`
 * exactly, so a global setting added without teaching import about it fails the
 * build rather than producing a file that quietly loses it.
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
};

const KNOWN_KEYS = GLOBAL_SETTING_KEYS;

/* -------------------------------------------------------------------------- */
/* Plugin settings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The plugin schemas to validate against, keyed by plugin id.
 *
 * A caller builds this from the registry — `Object.fromEntries(PLUGINS.map(p =>
 * [p.id, p.settings]))` — so a new plugin is validated the moment it is
 * registered. A plugin with no settings still belongs here, with `undefined`:
 * that is what makes it a *known* plugin whose `enabled` flag may be imported,
 * as opposed to one this build has never heard of.
 */
export type PluginSchemas = Readonly<Record<string, SettingsSchema | undefined>>;

/**
 * The registry, as schemas. Structurally typed on purpose — it takes anything
 * with an id and an optional schema, so this module never imports the plugin
 * list and the caller never hand-writes the mapping.
 */
export function schemasOf(
  plugins: ReadonlyArray<{ id: string; settings?: SettingsSchema }>,
): PluginSchemas {
  const out: Record<string, SettingsSchema | undefined> = {};
  for (const plugin of plugins) out[plugin.id] = plugin.settings;
  return out;
}

/** The two ways a value can be wrong, told apart so the notes can say which. */
interface FieldOutcome {
  value?: unknown;
  /** The value was the right kind but out of bounds, and was brought back in. */
  adjusted: boolean;
}

/**
 * One plugin setting, read through the host's own `coerce`.
 *
 * Sharing `coerce` is the point: a value that survives import is exactly a value
 * the running plugin would have accepted from storage, so import can never put a
 * plugin into a state it could not already be in. What is added here is the
 * *reporting* — `coerce` silently substitutes the default, and an import that
 * discarded half a file in silence is the failure this module exists to avoid.
 */
function readPluginField(definition: SettingDefinition, raw: unknown): FieldOutcome {
  const value = coerce(definition, raw);
  if (value === raw) return { value, adjusted: false };

  // Same kind, different value: clamped or truncated. A different kind entirely
  // means `coerce` fell back to the default, which is a value the file did not
  // ask for — so it is dropped and reported rather than quietly accepted.
  const sameKind =
    (definition.type === 'number' && typeof raw === 'number' && Number.isFinite(raw)) ||
    (definition.type === 'string' && typeof raw === 'string');

  return sameKind ? { value, adjusted: true } : { adjusted: false };
}

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
   * Per-plugin settings, validated and ready to store. Always present, and
   * empty when the file named none — an absent `plugins` section means "this
   * file has nothing to say about plugins", never "reset them".
   */
  plugins: PluginBags;
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
export function parseSettingsFile(
  text: string,
  schemas: PluginSchemas = {},
): ImportResult {
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

  /*
   * The plugin half.
   *
   * Same rules as above, one level deeper, and driven entirely by the schemas
   * the caller supplied: an id nobody declared is reported by name and dropped,
   * a key the plugin does not declare is reported by `id.key` and dropped, and
   * a declared key goes through the host's `coerce`. Nothing is spread, and the
   * result carries a null prototype for the same reason `normalize` does — a
   * plugin id comes out of the file, so `plugins.__proto__` is a possible key
   * and must land as an ordinary one.
   */
  const plugins: PluginBags = Object.create(null) as PluginBags;
  const unknownPlugins: string[] = [];

  if (isPlainObject(parsed.plugins)) {
    for (const [id, raw] of Object.entries(parsed.plugins)) {
      if (!Object.hasOwn(schemas, id)) {
        unknownPlugins.push(id);
        continue;
      }
      if (!isPlainObject(raw)) {
        ignored.push(id);
        continue;
      }

      const schema = schemas[id] ?? {};
      const bag: Record<string, unknown> = {};

      // `enabled` is every plugin's implicit setting: it is the host's, not the
      // schema's, so it is read here rather than looked up in one.
      if (Object.hasOwn(raw, 'enabled')) {
        // `typeof`, deliberately not truthiness: `"false"` and `0` are what a
        // hand-edited file contains when someone meant off, and guessing which
        // is worse than refusing.
        if (typeof raw.enabled === 'boolean') bag.enabled = raw.enabled;
        else ignored.push(`${id}.enabled`);
      }

      for (const [key, definition] of Object.entries(schema)) {
        if (!Object.hasOwn(raw, key)) continue;
        const outcome = readPluginField(definition, raw[key]);
        if (outcome.value === undefined && !outcome.adjusted) {
          ignored.push(`${id}.${key}`);
          continue;
        }
        if (outcome.adjusted) adjusted.push(`${id}.${key}`);
        bag[key] = outcome.value;
      }

      for (const key of Object.keys(raw)) {
        if (key !== 'enabled' && !Object.hasOwn(schema, key)) unknown.push(`${id}.${key}`);
      }

      // An empty bag is still stored: "this plugin was in the file and had
      // nothing to say" and "this plugin was not in the file" are the same
      // outcome, and writing one key rather than none costs nothing.
      plugins[id] = bag;
    }
  }

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
  if (unknownPlugins.length > 0) {
    // Named separately from the stray keys above, because this one has a
    // plausible innocent cause: a file from a build with a plugin this one does
    // not have. Saying which is the difference between "you are missing
    // something" and "that file is odd".
    notes.push(
      `Skipped settings for ${unknownPlugins.length === 1 ? 'a feature' : 'features'} this version doesn't have: ${list(unknownPlugins)}.`,
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

  return { ok: true, settings, plugins, notes, fromFuture };
}

/**
 * Validate, then write. The write only happens on a fully validated object, so
 * "the import failed" and "settings are unchanged" are the same statement.
 */
export async function importSettings(
  text: string,
  schemas: PluginSchemas = {},
): Promise<ImportResult> {
  const result = parseSettingsFile(text, schemas);
  if (!result.ok) return result;

  await saveSettings(result.settings);
  await savePluginSettings(result.plugins);
  return result;
}

/**
 * Merges imported plugin bags over what is stored, rather than replacing it.
 *
 * A file says what it says: a plugin it never mentions must keep the settings
 * the reader already has, exactly as a global setting missing from the file is
 * left as it was set here. Written straight to the storage key rather than
 * through the host, because the options page has no plugin host — the host
 * picks the change up from its own storage subscription.
 */
async function savePluginSettings(imported: PluginBags): Promise<void> {
  if (Object.keys(imported).length === 0) return;

  try {
    const stored = await chrome.storage.local.get(PLUGIN_SETTINGS_KEY);
    const current = normalizeBags(stored[PLUGIN_SETTINGS_KEY]);

    for (const [id, bag] of Object.entries(imported)) {
      current.plugins[id] = { ...current.plugins[id], ...bag };
    }

    await chrome.storage.local.set({ [PLUGIN_SETTINGS_KEY]: current });
  } catch {
    // Storage can fail in a torn-down context. The global settings are already
    // written; losing the plugin half is worth reporting, not throwing over.
  }
}

/**
 * The stored blob, read defensively. A narrower `normalize` than the host's on
 * purpose: this one must not discard a bag it does not recognise, because the
 * plugin that owns it may simply not be loaded in the options page.
 */
function normalizeBags(raw: unknown): StoredSettings {
  const empty: StoredSettings = {
    version: PLUGIN_SETTINGS_VERSION,
    global: {},
    plugins: Object.create(null) as PluginBags,
  };
  if (!isPlainObject(raw) || raw.version !== PLUGIN_SETTINGS_VERSION) return empty;

  if (isPlainObject(raw.global)) empty.global = { ...raw.global };
  if (isPlainObject(raw.plugins)) {
    for (const [id, bag] of Object.entries(raw.plugins)) {
      if (isPlainObject(bag)) empty.plugins[id] = { ...bag };
    }
  }
  return empty;
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
