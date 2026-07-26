/**
 * The options page's view of the plugin system.
 *
 * There is deliberately **no `PluginHost` here**. A host's job is lifecycle:
 * `start()` runs every enabled plugin's `setup()`, and those attach keydown
 * listeners, mutation observers and overlays to `document` — which on this page
 * is the settings page, not a rendered document. Toggling a switch would then
 * tear down behaviour that should never have been started. Everything this page
 * actually needs is static: `PLUGINS` is an array, and the settings are a JSON
 * blob under one storage key, read and written with the same helpers the host
 * uses so a value cannot be validated one way here and another way there.
 *
 * Failures are the one thing that is not static — see `lib/plugin-failures.ts`.
 */

import { PLUGINS } from '@/lib/plugins';
import {
  coerce,
  emptySettings,
  normalize,
  PLUGIN_SETTINGS_KEY,
  type StoredSettings,
} from '@/lib/plugins/settings';
import type {
  AnyPlugin,
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsSchema,
  StringSetting,
} from '@/lib/plugins/types';

export { PLUGINS, emptySettings };
export type { AnyPlugin, StoredSettings };

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

export async function readPluginSettings(): Promise<StoredSettings> {
  try {
    const stored = await chrome.storage.local.get(PLUGIN_SETTINGS_KEY);
    return normalize(stored[PLUGIN_SETTINGS_KEY]);
  } catch {
    // Defaults are a working extension, and the page must still render.
    return emptySettings();
  }
}

export async function writePluginSettings(next: StoredSettings): Promise<void> {
  await chrome.storage.local.set({ [PLUGIN_SETTINGS_KEY]: next });
}

/**
 * Notify when the blob changes underneath us — a viewer tab enabling something
 * from the command palette, or another copy of this page.
 */
export function onPluginSettingsChanged(
  fn: (next: StoredSettings) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local' || !Object.hasOwn(changes, PLUGIN_SETTINGS_KEY)) return;
    fn(normalize(changes[PLUGIN_SETTINGS_KEY].newValue));
  };

  try {
    chrome.storage.onChanged.addListener(listener);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      // The context is already gone; there is nothing left to detach from.
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** The same rule `PluginHost.isEnabled` applies: stored value, else the default. */
export function isPluginEnabled(
  plugin: AnyPlugin,
  stored: StoredSettings,
): boolean {
  const value = stored.plugins[plugin.id]?.enabled;
  return typeof value === 'boolean' ? value : plugin.enabledByDefault;
}

/**
 * One setting, paired with the value it currently holds.
 *
 * This is the answer to the schema-erasure problem, in one place. `PLUGINS` is
 * `AnyPlugin[]`, so a plugin's `settings` widens to `SettingsSchema` and its
 * resolved values widen to `SettingsOf<SettingsSchema>` — an object with no
 * usable keys, which is why reading `ctx.settings[key]` on this page types as
 * `never` and tempts a cast at every control.
 *
 * A discriminated union sidesteps it rather than fighting it: `definition` and
 * `value` are narrowed together by the single `switch` in `PluginSetting`, so
 * the slider is handed a `number` and the select an `EnumSetting`, with no cast
 * anywhere and no way to render the wrong control for a type.
 *
 * The tag is repeated at the top level rather than read through
 * `definition.type`: TypeScript narrows a union by a discriminant it can reach
 * directly, and a nested one would leave every branch casting again — which is
 * the problem this type exists to remove.
 */
export type SettingEntry =
  | { type: 'boolean'; key: string; definition: BooleanSetting; value: boolean }
  | { type: 'number'; key: string; definition: NumberSetting; value: number }
  | { type: 'string'; key: string; definition: StringSetting; value: string }
  | { type: 'enum'; key: string; definition: EnumSetting; value: string };

export function settingEntries(
  plugin: AnyPlugin,
  stored: StoredSettings,
): SettingEntry[] {
  const bag = stored.plugins[plugin.id];
  // Annotated rather than inferred: `AnyPlugin` is `Plugin<any>`, so its
  // `settings` arrives as `any` and every entry below would be `unknown`.
  const schema: SettingsSchema = plugin.settings ?? {};

  return Object.entries(schema).map(([key, definition]) => {
    // `coerce` is the host's, so an out-of-range or wrong-typed stored value is
    // shown here exactly as the plugin would receive it.
    const value = Object.hasOwn(bag ?? {}, key)
      ? coerce(definition, bag![key])
      : definition.default;

    // The one cast on the page, and it is confined to this line: `coerce`
    // returns `unknown` because it is written against the whole union, and the
    // tag below is what re-attaches the type to the definition that produced
    // it. Both come from the same `definition`, so they cannot disagree.
    return { type: definition.type, key, definition, value } as SettingEntry;
  });
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pure updates returning a fresh blob, so React state and the storage write are
 * given the same value and cannot disagree about what was saved.
 */
export function withEnabled(
  stored: StoredSettings,
  id: string,
  enabled: boolean,
): StoredSettings {
  return {
    ...stored,
    plugins: { ...stored.plugins, [id]: { ...stored.plugins[id], enabled } },
  };
}

export function withSetting(
  stored: StoredSettings,
  id: string,
  key: string,
  value: unknown,
): StoredSettings {
  return {
    ...stored,
    plugins: { ...stored.plugins, [id]: { ...stored.plugins[id], [key]: value } },
  };
}
