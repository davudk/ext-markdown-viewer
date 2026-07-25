/**
 * The plugin host, tested as a contract rather than by example.
 *
 * Two properties carry the whole architecture: a plugin that misbehaves cannot
 * take the viewer down, and disabling a plugin undoes everything it did. Both
 * are easy to believe and easy to break, so they are asserted directly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PluginHost, sortPlugins, type HostStorage } from '../lib/plugins/host.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { coerce, normalize, resolve } from '../lib/plugins/settings.ts';
import {
  PLUGIN_API_VERSION,
  type AnyPlugin,
  type DocumentHandle,
} from '../lib/plugins/types.ts';

/** Storage that stays in memory, so a test never touches chrome.storage. */
function memoryStorage(): HostStorage & { value: unknown } {
  return {
    value: null,
    async read() {
      return this.value;
    },
    async write(next) {
      this.value = JSON.parse(JSON.stringify(next));
    },
  };
}

const stubDocument: DocumentHandle = {
  body: null,
  source: '',
  html: '',
  headings: [],
  url: 'https://example.test/a.md',
  isRaw: false,
  onChange: () => () => {},
  enhance: () => () => {},
  refresh: () => {},
};

const silent = { warn: () => {}, error: () => {} };

function makeHost(plugins: AnyPlugin[], storage = memoryStorage()) {
  return {
    host: new PluginHost({ plugins, storage, document: stubDocument, logger: silent }),
    storage,
  };
}

function plugin(overrides: Partial<AnyPlugin> & { id: string }): AnyPlugin {
  return {
    name: overrides.id,
    description: '',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

test('only enabled plugins are set up', async () => {
  const ran: string[] = [];
  const { host } = makeHost([
    plugin({ id: 'on', setup: () => void ran.push('on') }),
    plugin({ id: 'off', enabledByDefault: false, setup: () => void ran.push('off') }),
  ]);

  await host.start();
  assert.deepEqual(ran, ['on']);
});

test('a disabled plugin registers nothing at all', async () => {
  // The point of the whole design: off means the code never runs, so there is
  // no worker, no index, and no listener to leak.
  const { host } = makeHost([
    plugin({
      id: 'heavy',
      enabledByDefault: false,
      ui: [{ region: 'chrome.top-end', key: 'x', component: () => null }],
      provides: ['heavy.region'],
      setup: (ctx) => {
        ctx.commands.add({ id: 'c', title: 't', category: 'x', run: () => {} });
        throw new Error('setup must never run for a disabled plugin');
      },
    }),
  ]);

  await host.start();
  assert.equal(host.commands.all().length, 0);
  assert.equal(host.regions.has('heavy.region'), false);
  assert.equal(host.regions.for('chrome.top-end').length, 0);
});

test('disabling undoes every registration', async () => {
  const { host } = makeHost([
    plugin({
      id: 'busy',
      provides: ['busy.slot'],
      ui: [{ region: 'busy.slot', key: 'panel', component: () => null }],
      setup: (ctx) => {
        ctx.commands.add({ id: 'busy.run', title: 'Run', category: 'Busy', run: () => {} });
        ctx.capabilities.provide('busy' as never, { ok: true } as never);
      },
    }),
  ]);

  await host.start();
  assert.equal(host.commands.all().length, 1);
  assert.equal(host.regions.for('busy.slot').length, 1);
  assert.notEqual(host.capabilities.use('busy' as never), undefined);

  await host.setEnabled('busy', false);

  assert.equal(host.commands.all().length, 0, 'a command survived teardown');
  assert.equal(host.regions.has('busy.slot'), false, 'a region survived teardown');
  assert.equal(host.capabilities.use('busy' as never), undefined, 'a capability survived');
});

test('enable and disable repeatedly leaves no residue', async () => {
  // The failure this catches is a plugin that registers on every enable but
  // only removes once — which looks fine until the third toggle.
  const { host } = makeHost([
    plugin({
      id: 'toggler',
      setup: (ctx) => {
        ctx.commands.add({ id: 'x', title: 'X', category: 'C', run: () => {} });
      },
    }),
  ]);

  await host.start();
  for (let i = 0; i < 5; i += 1) {
    await host.setEnabled('toggler', false);
    await host.setEnabled('toggler', true);
  }

  assert.equal(host.commands.all().length, 1);
});

test('a plugin that throws is disabled and the others still load', async () => {
  const ran: string[] = [];
  const { host } = makeHost([
    plugin({ id: 'before', setup: () => void ran.push('before') }),
    plugin({
      id: 'broken',
      setup: () => {
        throw new Error('boom');
      },
    }),
    plugin({ id: 'after', setup: () => void ran.push('after') }),
  ]);

  await host.start();

  assert.deepEqual(ran, ['before', 'after'], 'a throwing plugin stopped its siblings');
  const broken = host.statuses().find((s) => s.id === 'broken');
  assert.equal(broken?.enabled, false);
  assert.match(broken?.failure ?? '', /boom/);
});

test('a plugin that throws mid-setup leaves nothing behind', async () => {
  const { host } = makeHost([
    plugin({
      id: 'halfway',
      provides: ['halfway.slot'],
      setup: (ctx) => {
        ctx.commands.add({ id: 'ghost', title: 'Ghost', category: 'C', run: () => {} });
        throw new Error('failed after registering');
      },
    }),
  ]);

  await host.start();
  assert.equal(host.commands.all().length, 0, 'a half-started plugin left a command');
  assert.equal(host.regions.has('halfway.slot'), false);
});

test('a throwing teardown does not block the rest', async () => {
  const torn: string[] = [];
  const { host } = makeHost([
    plugin({
      id: 'rude',
      setup: (ctx) => {
        ctx.commands.add({ id: 'a', title: 'A', category: 'C', run: () => {} });
        return () => {
          torn.push('rude');
          throw new Error('teardown exploded');
        };
      },
    }),
  ]);

  await host.start();
  await host.setEnabled('rude', false);

  assert.deepEqual(torn, ['rude']);
  assert.equal(host.commands.all().length, 0, 'the command outlived a throwing teardown');
});

test('a wrong apiVersion is refused, not run', async () => {
  const { host } = makeHost([
    plugin({
      id: 'ancient',
      apiVersion: PLUGIN_API_VERSION + 1,
      setup: () => {
        throw new Error('must not run');
      },
    }),
  ]);

  await host.start();
  const status = host.statuses().find((s) => s.id === 'ancient');
  assert.equal(status?.enabled, false);
  assert.match(status?.failure ?? '', /apiVersion/);
});

test('contributions to a region nobody declared are inert', async () => {
  // A sidebar tab with the sidebar disabled: normal, not an error.
  const { host } = makeHost([
    plugin({
      id: 'tab',
      ui: [{ region: 'sidebar.tab', key: 'outline', component: () => null }],
    }),
  ]);

  await host.start();
  assert.equal(host.regions.for('sidebar.tab').length, 0);
});

test('contributions render in order, ties broken deterministically', async () => {
  const { host } = makeHost([
    plugin({
      id: 'host-plugin',
      provides: ['slot'],
      ui: [{ region: 'slot', key: 'late', order: 200, component: () => null }],
    }),
    plugin({ id: 'a', ui: [{ region: 'slot', key: 'a', component: () => null }] }),
    plugin({ id: 'b', ui: [{ region: 'slot', key: 'b', component: () => null }] }),
  ]);

  await host.start();
  assert.deepEqual(
    host.regions.for('slot').map((c) => c.key),
    ['a', 'b', 'late'],
  );
});

test('after: orders load without being a dependency on behaviour', () => {
  const order = sortPlugins(
    [
      plugin({ id: 'palette', after: ['export'] }),
      plugin({ id: 'export' }),
      plugin({ id: 'outline' }),
    ],
    silent,
  ).map((p) => p.id);

  assert.ok(order.indexOf('export') < order.indexOf('palette'));
  assert.equal(order.length, 3);
});

test('a cycle is reported and ignored rather than hanging', () => {
  const order = sortPlugins(
    [plugin({ id: 'a', after: ['b'] }), plugin({ id: 'b', after: ['a'] })],
    silent,
  ).map((p) => p.id);

  assert.equal(order.length, 2, 'a cycle dropped a plugin');
});

test('after: naming a plugin that is not installed still loads', () => {
  const order = sortPlugins([plugin({ id: 'lonely', after: ['ghost'] })], silent);
  assert.deepEqual(order.map((p) => p.id), ['lonely']);
});

test('a missing capability is undefined, never a throw', async () => {
  let seen: unknown = 'unset';
  const { host } = makeHost([
    plugin({ id: 'consumer', setup: (ctx) => void (seen = ctx.capabilities.use('nope' as never)) }),
  ]);

  await host.start();
  assert.equal(seen, undefined);
});

test('settings are typed, defaulted, and namespaced per plugin', async () => {
  let fromA: unknown;
  let fromB: unknown;

  const { host } = makeHost([
    plugin({
      id: 'a',
      settings: { mode: { type: 'enum', default: 'x', options: [{ value: 'x', label: 'X' }], label: 'Mode' } },
      setup: (ctx) => void (fromA = ctx.settings.mode),
    }),
    plugin({
      id: 'b',
      // The same key in two plugins must not collide.
      settings: { mode: { type: 'enum', default: 'y', options: [{ value: 'y', label: 'Y' }], label: 'Mode' } },
      setup: (ctx) => void (fromB = ctx.settings.mode),
    }),
  ]);

  await host.start();
  assert.equal(fromA, 'x');
  assert.equal(fromB, 'y');
});

test('settings are read live, not captured at setup', async () => {
  let read: (() => unknown) | null = null;
  let write: ((patch: { size: number }) => Promise<void>) | null = null;

  const { host, storage } = makeHost([
    plugin({
      id: 'live',
      settings: { size: { type: 'number', default: 10, min: 1, max: 100, label: 'Size' } },
      setup: (ctx) => {
        // Both closures capture `ctx`, which is what a real plugin does — the
        // getter has to stay live across the whole life of the document.
        read = () => ctx.settings.size;
        write = (patch) => ctx.updateSettings(patch);
      },
    }),
  ]);

  await host.start();
  assert.equal(read!(), 10, 'the default did not reach the plugin');

  await write!({ size: 42 });
  assert.equal(read!(), 42, 'settings were captured at setup instead of read live');

  const persisted = storage.value as { plugins: Record<string, { size?: number }> };
  assert.equal(persisted.plugins.live?.size, 42, 'the write never reached storage');
});

test('a plugin can only write its own settings namespace', async () => {
  let write: ((patch: Record<string, unknown>) => Promise<void>) | null = null;

  const { host, storage } = makeHost([
    plugin({
      id: 'a',
      settings: { size: { type: 'number', default: 1, min: 0, max: 9, label: 'Size' } },
      setup: (ctx) => void (write = (patch) => ctx.updateSettings(patch as never)),
    }),
    plugin({
      id: 'b',
      settings: { size: { type: 'number', default: 5, min: 0, max: 9, label: 'Size' } },
    }),
  ]);

  await host.start();
  await write!({ size: 9 });

  const stored = storage.value as { plugins: Record<string, { size?: number }> };
  assert.equal(stored.plugins.a?.size, 9);
  assert.equal(stored.plugins.b?.size, undefined, "one plugin wrote into another's namespace");
});

test('out-of-range and wrong-typed stored values fall back safely', () => {
  const number = { type: 'number', default: 16, min: 8, max: 32, label: 'n' } as const;
  assert.equal(coerce(number, 400), 32);
  assert.equal(coerce(number, -5), 8);
  assert.equal(coerce(number, 'huge'), 16);
  assert.equal(coerce(number, Number.NaN), 16);

  const choice = {
    type: 'enum',
    default: 'auto',
    options: [{ value: 'auto', label: 'A' }, { value: 'on', label: 'O' }],
    label: 'c',
  } as const;
  assert.equal(coerce(choice, 'on'), 'on');
  assert.equal(coerce(choice, 'nonsense'), 'auto');
});

test('stored settings cannot pollute the prototype', () => {
  const stored = normalize({
    version: 1,
    global: {},
    plugins: JSON.parse('{"__proto__":{"polluted":"yes"},"real":{"enabled":true}}'),
  });

  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    'Object.prototype was polluted by a settings blob',
  );
  assert.equal(stored.plugins.real?.enabled, true);
});

test('an unknown stored version falls back to defaults', () => {
  const stored = normalize({ version: 999, global: { theme: 'dark' }, plugins: { a: {} } });
  assert.deepEqual(stored.plugins, {});
  assert.deepEqual(stored.global, {});
});

test('resolve merges stored over defaults without inventing keys', () => {
  const schema = {
    on: { type: 'boolean', default: false, label: 'On' },
    size: { type: 'number', default: 4, min: 1, max: 8, label: 'Size' },
  } as const;

  const merged = resolve(schema, { on: true, bogus: 1 } as Record<string, unknown>);
  assert.deepEqual(merged, { on: true, size: 4 });
});

/* -------------------------------------------------------------------------- */
/* The shared document                                                         */
/* -------------------------------------------------------------------------- */

test('an enhancement pass runs, and its teardown undoes it before each re-run', () => {
  const doc = new SharedDocument();
  const body = { tagName: 'MAIN' } as unknown as HTMLElement;
  const log: string[] = [];

  doc.enhance(() => {
    log.push('run');
    return () => log.push('undo');
  });

  // No requestAnimationFrame under the bare test runner, so passes run inline.
  doc.update({ body, source: '', html: '', headings: [], url: 'u', isRaw: false });
  assert.deepEqual(log, ['run']);

  doc.refresh();
  assert.deepEqual(log, ['run', 'undo', 'run'], 'a re-run skipped the previous undo');
});

test('removing a pass undoes it', () => {
  const doc = new SharedDocument();
  const body = {} as HTMLElement;
  const log: string[] = [];

  const stop = doc.enhance(() => () => log.push('undo'));
  doc.update({ body, source: '', html: '', headings: [], url: 'u', isRaw: false });
  stop();

  assert.deepEqual(log, ['undo']);
});

test('a new body drops stale teardowns instead of running them', () => {
  // The old teardown points at nodes that are no longer in any document;
  // running it would at best do nothing and at worst throw.
  const doc = new SharedDocument();
  const log: string[] = [];

  doc.enhance(() => () => log.push('undo'));
  doc.update({ body: {} as HTMLElement, source: '', html: '', headings: [], url: 'u', isRaw: false });
  log.length = 0;

  doc.update({ body: {} as HTMLElement, source: '', html: '', headings: [], url: 'u', isRaw: false });
  assert.deepEqual(log, [], 'a teardown ran against a detached body');
});

test('one pass throwing does not stop the others', () => {
  const doc = new SharedDocument();
  const ran: string[] = [];
  const original = console.error;
  console.error = () => {};

  try {
    doc.enhance(() => {
      throw new Error('boom');
    });
    doc.enhance(() => void ran.push('second'));
    doc.update({ body: {} as HTMLElement, source: '', html: '', headings: [], url: 'u', isRaw: false });
  } finally {
    console.error = original;
  }

  assert.deepEqual(ran, ['second']);
});
