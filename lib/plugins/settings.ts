/**
 * Settings storage for the plugin system: one global bag, one namespaced bag
 * per plugin.
 *
 * Namespacing under the plugin id is what lets two plugins both own a `mode`
 * without either knowing the other exists. Nothing here is a migration —
 * the extension is unpublished, so the shape is free to change.
 */

import type {
  SettingDefinition,
  SettingsOf,
  SettingsSchema,
} from './types.ts';

export const PLUGIN_SETTINGS_KEY = 'pluginSettings';

/** Bumped when the stored shape changes. Unknown versions fall back to defaults. */
export const PLUGIN_SETTINGS_VERSION = 1;

export interface StoredSettings {
  version: number;
  global: Record<string, unknown>;
  plugins: Record<string, { enabled?: boolean } & Record<string, unknown>>;
}

export function emptySettings(): StoredSettings {
  return { version: PLUGIN_SETTINGS_VERSION, global: {}, plugins: {} };
}

/** The schema's defaults, as a plain object. */
export function defaultsFor<S extends SettingsSchema>(schema: S | undefined): SettingsOf<S> {
  const out: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(schema ?? {})) {
    out[key] = definition.default;
  }
  return out as SettingsOf<S>;
}

/**
 * One stored value, coerced to what the schema promises.
 *
 * Stored values are untrusted even though they are ours: an imported settings
 * file, a hand-edited profile, or a schema that changed under an existing
 * install can all put the wrong shape here. A bad value falls back to the
 * default rather than reaching a plugin as the wrong type.
 */
export function coerce(definition: SettingDefinition, value: unknown): unknown {
  switch (definition.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : definition.default;

    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return definition.default;
      return Math.min(definition.max, Math.max(definition.min, value));
    }

    case 'string': {
      if (typeof value !== 'string') return definition.default;
      return definition.maxLength === undefined
        ? value
        : value.slice(0, definition.maxLength);
    }

    case 'enum':
      return definition.options.some((option) => option.value === value)
        ? value
        : definition.default;
  }
}

/** Merges stored values over the schema's defaults, coercing as it goes. */
export function resolve<S extends SettingsSchema>(
  schema: S | undefined,
  stored: Record<string, unknown> | undefined,
): SettingsOf<S> {
  const out: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(schema ?? {})) {
    out[key] = Object.hasOwn(stored ?? {}, key)
      ? coerce(definition, stored![key])
      : definition.default;
  }
  return out as SettingsOf<S>;
}

/**
 * Reads the stored blob defensively.
 *
 * `Object.hasOwn` rather than `in` throughout, and a null-prototype copy of the
 * plugin bag: a settings file is user-supplied input, and `__proto__` in a
 * parsed object must land as an ordinary key rather than reaching a prototype.
 */
export function normalize(raw: unknown): StoredSettings {
  if (typeof raw !== 'object' || raw === null) return emptySettings();

  const source = raw as Record<string, unknown>;
  if (source.version !== PLUGIN_SETTINGS_VERSION) return emptySettings();

  const global =
    typeof source.global === 'object' && source.global !== null
      ? { ...(source.global as Record<string, unknown>) }
      : {};

  const plugins: StoredSettings['plugins'] = Object.create(null);
  if (typeof source.plugins === 'object' && source.plugins !== null) {
    for (const [id, value] of Object.entries(source.plugins as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        plugins[id] = { ...(value as Record<string, unknown>) };
      }
    }
  }

  return { version: PLUGIN_SETTINGS_VERSION, global, plugins };
}
