/**
 * The plugin API.
 *
 * Internal, but written to a public-API standard: versioned, documented, and
 * defensive. A plugin is a value, not a subclass — the host owns every
 * lifecycle decision, so a plugin can only describe what it contributes.
 *
 * Three concerns are kept apart on purpose:
 *
 *   - `setup`      imperative work, returning its own teardown
 *   - `ui`         declarative contributions; the host decides where and when
 *   - `markdownIt` parser extension, applied once when the parser is built
 *
 * `setup` returns the teardown rather than pairing with a `destroy` method
 * because the two cannot then drift apart: whatever the closure captured is
 * exactly what the teardown sees.
 */

import type { ComponentType } from 'react';
import type MarkdownIt from 'markdown-it';

import type { Heading } from '@/lib/markdown';

/** Bumped on a breaking change. A plugin declaring another major is refused. */
export const PLUGIN_API_VERSION = 1;

export type Teardown = () => void;

/* -------------------------------------------------------------------------- */
/* Settings schema                                                             */
/* -------------------------------------------------------------------------- */

interface SettingBase {
  label: string;
  description?: string;
}

export interface BooleanSetting extends SettingBase {
  type: 'boolean';
  default: boolean;
}

export interface NumberSetting extends SettingBase {
  type: 'number';
  default: number;
  min: number;
  max: number;
  step?: number;
  /** Shown beside the value, e.g. `px`. */
  unit?: string;
}

export interface StringSetting extends SettingBase {
  type: 'string';
  default: string;
  multiline?: boolean;
  maxLength?: number;
}

export interface EnumSetting<V extends string = string> extends SettingBase {
  type: 'enum';
  default: V;
  options: ReadonlyArray<{ value: V; label: string }>;
}

export type SettingDefinition =
  | BooleanSetting
  | NumberSetting
  | StringSetting
  | EnumSetting;

export type SettingsSchema = Record<string, SettingDefinition>;

/** The schema's runtime shape, so `ctx.settings.fontSize` is a number with no cast. */
export type SettingsOf<S extends SettingsSchema> = {
  readonly [K in keyof S]: S[K] extends BooleanSetting
    ? boolean
    : S[K] extends NumberSetting
      ? number
      : S[K] extends EnumSetting<infer V>
        ? V
        : S[K] extends StringSetting
          ? string
          : never;
};

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The rendered document and its lifecycle, shared by every plugin.
 *
 * This exists because four components each located `.mdv-body` for themselves
 * and three ran their own `MutationObserver`. One observer, one enhancement
 * frame, one answer to "is the raw view showing".
 */
export interface DocumentHandle {
  readonly body: HTMLElement | null;
  readonly source: string;
  readonly headings: readonly Heading[];
  readonly url: string;
  readonly isRaw: boolean;

  /** Fires after every render, live reload and raw toggle. */
  onChange(fn: (body: HTMLElement) => void): Teardown;

  /**
   * A pass over the rendered body, batched with every other plugin's into one
   * post-paint frame and re-run whenever the document changes.
   *
   * The pass may return its own teardown; the host runs it before each re-run
   * and on disable, so a pass that grafts nodes can remove exactly those nodes
   * rather than guessing from the DOM later.
   */
  enhance(pass: (body: HTMLElement) => Teardown | void): Teardown;
}

/* -------------------------------------------------------------------------- */
/* UI                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A named mount point.
 *
 * The core shell publishes only regions that follow from its own layout. Any
 * plugin owning a surface publishes its own (`provides`), so the sidebar's tab
 * strip exists exactly while the sidebar does. Contributing to a region that
 * does not exist is inert — that is the correct behaviour when a reader
 * disables the plugin that owned it, and it needs no special case.
 */
export type RegionName = string;

export const CORE_REGIONS = [
  'chrome.top-start',
  'chrome.top-end',
  'chrome.bottom-start',
  'chrome.bottom-end',
  'document.before',
  'document.after',
  'settings.section',
] as const;

export interface UiContribution {
  region: RegionName;
  /** Stable within the plugin: the React key and the debugging handle. */
  key: string;
  /** Lower renders first. Defaults to 100; ties break by registry order. */
  order?: number;
  component: ComponentType;
}

export interface OverlayOptions {
  id: string;
  /** Names the dialog for assistive technology. */
  label: string;
  component: ComponentType<{ close: () => void }>;
  /** Modal overlays inert everything beneath and trap focus. Default true. */
  modal?: boolean;
  onClose?: () => void;
}

export interface OverlayHandle {
  close(): void;
  readonly isOpen: boolean;
}

export interface UiHost {
  /**
   * Open a managed overlay. The host owns stacking, inerting, focus trapping
   * and Escape — so no plugin picks a z-index and no plugin writes a focus
   * trap. Overlays opened from overlays nest and unwind in order.
   */
  openOverlay(options: OverlayOptions): OverlayHandle;

  /**
   * Imperative mount, for DOM code that is not React (the add-ons). The
   * exception rather than the norm: if most plugins reach for this, the region
   * set is wrong and should be fixed instead.
   */
  mount(region: RegionName, render: (host: HTMLElement) => Teardown | void): Teardown;
}

/* -------------------------------------------------------------------------- */
/* Commands, shortcuts, capabilities                                           */
/* -------------------------------------------------------------------------- */

export interface Command {
  id: string;
  title: string;
  /** Shown as the row's provenance in the palette. */
  category: string;
  hint?: string;
  run(): void | Promise<void>;
}

export interface CommandRegistry {
  add(command: Command): Teardown;
  all(): readonly Command[];
}

export interface ShortcutRegistry {
  /** `key` is a `KeyboardEvent.key`, matched case-insensitively. */
  add(binding: {
    key: string;
    ctrlOrMeta?: boolean;
    shift?: boolean;
    run: (event: KeyboardEvent) => void;
  }): Teardown;
}

/**
 * Cross-plugin calls, typed.
 *
 * Plugins augment this interface via declaration merging, so `use()` returns a
 * real type and a typo is a compile error. Absence is a normal, handled state —
 * never an exception — because the provider may simply be disabled.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Capabilities {}

export interface CapabilityRegistry {
  provide<K extends keyof Capabilities>(name: K, value: Capabilities[K]): Teardown;
  use<K extends keyof Capabilities>(name: K): Capabilities[K] | undefined;
  /** Notifies when a capability appears or disappears, for reactive UI. */
  onChange(fn: () => void): Teardown;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

/** Settings no single plugin owns: they describe the document, not a feature. */
export interface GlobalSettings {
  readonly current: Readonly<Record<string, unknown>>;
  /**
   * Writing globals is deliberate rather than forbidden: the command palette's
   * "toggle theme" acts on the user's behalf, and routing that through a
   * capability would be the same act with more ceremony.
   */
  set(patch: Record<string, unknown>): Promise<void>;
  onChange(fn: () => void): Teardown;
}

export interface Logger {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface PluginContext<S extends SettingsSchema = SettingsSchema> {
  /** Live, never a stale snapshot — read it at the moment you need it. */
  readonly settings: SettingsOf<S>;
  updateSettings(patch: Partial<SettingsOf<S>>): Promise<void>;
  onSettingsChange(fn: (next: SettingsOf<S>) => void): Teardown;

  readonly global: GlobalSettings;
  readonly document: DocumentHandle;
  readonly ui: UiHost;
  readonly commands: CommandRegistry;
  readonly shortcuts: ShortcutRegistry;
  readonly capabilities: CapabilityRegistry;
  readonly logger: Logger;
}

/* -------------------------------------------------------------------------- */
/* The plugin                                                                  */
/* -------------------------------------------------------------------------- */

export interface Plugin<S extends SettingsSchema = SettingsSchema> {
  /** Stable identity, and the settings key. Renaming is a breaking change. */
  id: string;
  name: string;
  description: string;
  apiVersion: number;

  enabledByDefault: boolean;

  /**
   * Load order only. Behaviour must go through `capabilities` — a plugin that
   * imports another directly defeats the point, and cannot be disabled alone.
   */
  after?: readonly string[];

  /** Regions this plugin publishes for others to fill. */
  provides?: readonly RegionName[];

  settings?: S;
  ui?: readonly UiContribution[];

  markdownIt?(md: MarkdownIt, ctx: PluginContext<S>): void;

  setup?(ctx: PluginContext<S>): Teardown | void | Promise<Teardown | void>;

  /**
   * Heavy code split into its own entrypoint, injected on demand. Only worth it
   * above roughly 20kB — below that the injection round-trip costs more than
   * the bytes saved. See `ADDONS` in lib/config.ts.
   */
  addon?: string;
}

/** Erases the schema so plugins with different settings share one array. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPlugin = Plugin<any>;
