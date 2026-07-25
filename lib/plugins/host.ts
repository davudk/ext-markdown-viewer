/**
 * The plugin host: loads, enables, disables, and tears down.
 *
 * Two properties matter more than the rest, and both are tested as contracts:
 *
 *   - **Nothing a plugin does can take the viewer down.** `setup`, `teardown`
 *     and `markdownIt` all run inside a boundary. A plugin that throws is
 *     disabled and reported; the document still renders. Before this, a throw
 *     anywhere in the tree blanked the page.
 *   - **Disabling undoes everything.** Every registration a plugin makes is
 *     handed back as a teardown and unwound in reverse. A plugin that cannot
 *     detach cleanly is a bug, and the residue test is how it gets found.
 */

import {
  CapabilityStore,
  Commands,
  OverlayRegistry,
  RegionRegistry,
  Shortcuts,
  Store,
} from './registry.ts';
import { defaultsFor, normalize, resolve, type StoredSettings } from './settings.ts';
import {
  PLUGIN_API_VERSION,
  type AnyPlugin,
  type DocumentHandle,
  type GlobalSettings,
  type Logger,
  type PluginContext,
  type SettingsSchema,
  type Teardown,
} from './types.ts';

export interface HostStorage {
  read(): Promise<unknown>;
  write(value: StoredSettings): Promise<void>;
}

export interface HostOptions {
  plugins: readonly AnyPlugin[];
  storage: HostStorage;
  document: DocumentHandle;
  logger?: Logger;
}

export interface PluginStatus {
  id: string;
  enabled: boolean;
  /** Set when the plugin was disabled because it threw, rather than by choice. */
  failure?: string;
}

const defaultLogger: Logger = {
  warn: (message, detail) => console.warn(`[mdv] ${message}`, detail ?? ''),
  error: (message, detail) => console.error(`[mdv] ${message}`, detail ?? ''),
};

/**
 * Load order: `after` declares a dependency on *ordering*, never on behaviour —
 * that goes through capabilities. A cycle or a reference to a plugin that is
 * not installed is reported and ignored rather than throwing, because one
 * mis-declared plugin must not stop the others loading.
 */
export function sortPlugins(
  plugins: readonly AnyPlugin[],
  logger: Logger = defaultLogger,
): AnyPlugin[] {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const sorted: AnyPlugin[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (plugin: AnyPlugin, trail: string[]) => {
    const seen = state.get(plugin.id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      logger.warn(`plugin cycle ignored: ${[...trail, plugin.id].join(' -> ')}`);
      return;
    }

    state.set(plugin.id, 'visiting');
    for (const dependency of plugin.after ?? []) {
      const target = byId.get(dependency);
      if (target) visit(target, [...trail, plugin.id]);
      else logger.warn(`${plugin.id} declares after: '${dependency}', which is not installed`);
    }
    state.set(plugin.id, 'done');
    sorted.push(plugin);
  };

  for (const plugin of plugins) visit(plugin, []);
  return sorted;
}

export class PluginHost {
  private readonly plugins: AnyPlugin[];
  private readonly logger: Logger;
  private stored: StoredSettings = { version: 1, global: {}, plugins: {} };

  private readonly active = new Map<string, Teardown[]>();
  private readonly failures = new Map<string, string>();

  readonly regions = new RegionRegistry();
  readonly overlays = new OverlayRegistry();
  readonly commands = new Commands();
  readonly capabilities = new CapabilityStore();
  readonly shortcuts = new Shortcuts();
  /** Bumps whenever a plugin is enabled or disabled, so the shell re-renders. */
  readonly status = new Store(0);

  private readonly options: HostOptions;

  constructor(options: HostOptions) {
    this.options = options;
    this.logger = options.logger ?? defaultLogger;
    this.plugins = sortPlugins(options.plugins, this.logger);
  }

  async start(): Promise<void> {
    this.stored = normalize(await this.options.storage.read().catch(() => null));

    for (const plugin of this.plugins) {
      if (this.isEnabled(plugin.id)) await this.activate(plugin);
    }
    this.status.set(this.status.get() + 1);
  }

  isEnabled(id: string): boolean {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return false;
    const stored = this.stored.plugins[id]?.enabled;
    return typeof stored === 'boolean' ? stored : plugin.enabledByDefault;
  }

  statuses(): PluginStatus[] {
    return this.plugins.map((plugin) => ({
      id: plugin.id,
      enabled: this.active.has(plugin.id),
      failure: this.failures.get(plugin.id),
    }));
  }

  /** Enables or disables without a page reload — which is what tests teardown. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return;

    this.stored.plugins[id] = { ...this.stored.plugins[id], enabled };
    await this.options.storage.write(this.stored).catch((error) => {
      this.logger.error(`could not persist ${id}`, error);
    });

    if (enabled && !this.active.has(id)) await this.activate(plugin);
    else if (!enabled && this.active.has(id)) this.deactivate(id);

    this.status.set(this.status.get() + 1);
  }

  /** Parser extensions from enabled plugins, each isolated from the others. */
  applyMarkdownIt(md: unknown): void {
    for (const plugin of this.plugins) {
      if (!plugin.markdownIt || !this.active.has(plugin.id)) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugin.markdownIt(md as any, this.contextFor(plugin));
      } catch (error) {
        this.fail(plugin.id, error, 'markdownIt');
      }
    }
  }

  async stop(): Promise<void> {
    for (const id of [...this.active.keys()]) this.deactivate(id);
    this.shortcuts.stop();
  }

  /* ---------------------------------------------------------------------- */

  private async activate(plugin: AnyPlugin): Promise<void> {
    if (plugin.apiVersion !== PLUGIN_API_VERSION) {
      this.fail(
        plugin.id,
        new Error(`declares apiVersion ${plugin.apiVersion}, host is ${PLUGIN_API_VERSION}`),
        'load',
      );
      return;
    }

    const teardowns: Teardown[] = [];
    this.active.set(plugin.id, teardowns);
    this.failures.delete(plugin.id);

    try {
      for (const region of plugin.provides ?? []) {
        teardowns.push(this.regions.declare(region));
      }
      if (plugin.ui?.length) {
        teardowns.push(this.regions.add(plugin.id, plugin.ui));
      }

      const result = await plugin.setup?.(this.contextFor(plugin));
      if (typeof result === 'function') teardowns.push(result);
    } catch (error) {
      this.fail(plugin.id, error, 'setup');
      // Unwind whatever registered before the throw, so a half-started plugin
      // leaves nothing behind.
      this.deactivate(plugin.id);
    }
  }

  private deactivate(id: string): void {
    const teardowns = this.active.get(id);
    this.active.delete(id);
    if (!teardowns) return;

    this.overlays.closeFor(id);

    // Reverse order: a teardown may depend on something registered before it.
    for (const teardown of [...teardowns].reverse()) {
      try {
        teardown();
      } catch (error) {
        this.logger.error(`${id} threw while tearing down`, error);
      }
    }
  }

  private fail(id: string, error: unknown, phase: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.failures.set(id, `${phase}: ${message}`);
    this.logger.error(`plugin '${id}' failed during ${phase}; disabling it`, error);
    this.status.set(this.status.get() + 1);
  }

  private contextFor<S extends SettingsSchema>(plugin: AnyPlugin): PluginContext<S> {
    const host = this;
    const teardowns = () => host.active.get(plugin.id);

    /** Registers a teardown against the plugin, so disabling undoes it. */
    const own = (teardown: Teardown): Teardown => {
      teardowns()?.push(teardown);
      return teardown;
    };

    const global: GlobalSettings = {
      get current() {
        return host.stored.global;
      },
      async set(patch) {
        host.stored.global = { ...host.stored.global, ...patch };
        await host.options.storage.write(host.stored);
      },
      onChange: (fn) => own(host.status.subscribe(fn)),
    };

    return {
      // A getter, not a captured value: a plugin holding this context for the
      // life of the document must not read settings frozen at setup time.
      get settings() {
        return resolve(plugin.settings, host.stored.plugins[plugin.id]) as never;
      },

      async updateSettings(patch) {
        host.stored.plugins[plugin.id] = {
          ...defaultsFor(plugin.settings),
          ...host.stored.plugins[plugin.id],
          ...patch,
        };
        await host.options.storage.write(host.stored);
        host.status.set(host.status.get() + 1);
      },

      onSettingsChange: (fn) =>
        own(
          host.status.subscribe(() =>
            fn(resolve(plugin.settings, host.stored.plugins[plugin.id]) as never),
          ),
        ),

      global,
      document: host.options.document,

      ui: {
        openOverlay: (options) => {
          const { instanceId, close } = host.overlays.open(plugin.id, options);
          return {
            close,
            get isOpen() {
              return host.overlays.isOpen(instanceId);
            },
          };
        },
        mount: (region, render) => {
          const contribution = {
            region,
            key: `${plugin.id}:mount:${region}`,
            component: () => null,
            imperative: render,
          };
          return own(host.regions.add(plugin.id, [contribution as never]));
        },
      },

      commands: {
        add: (command) => own(host.commands.add(command)),
        all: () => host.commands.all(),
      },

      shortcuts: { add: (binding) => own(host.shortcuts.add(binding)) },

      capabilities: {
        provide: (name, value) => own(host.capabilities.provide(name, value)),
        use: (name) => host.capabilities.use(name),
        onChange: (fn) => own(host.capabilities.onChange(fn)),
      },

      logger: {
        warn: (message, detail) => host.logger.warn(`[${plugin.id}] ${message}`, detail),
        error: (message, detail) => host.logger.error(`[${plugin.id}] ${message}`, detail),
      },
    } as PluginContext<S>;
  }
}
