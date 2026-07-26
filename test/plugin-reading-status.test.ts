/**
 * Reading status, through the real host.
 *
 * This plugin is almost entirely a rendered readout, and the bare runner cannot
 * mount a `.tsx` — so what is asserted here is everything that is *not* the
 * pixels: that the contribution reaches the region the shell publishes, that it
 * leaves with the plugin, that the two settings are its own and survive a round
 * trip through storage, and that the one judgement call in the feature — what
 * the headline number is called — is right.
 *
 * The component is a stand-in, exactly as in the sidebar's test. The plugin
 * object under test is otherwise the real one: the real id, the real region, the
 * real schema.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import type { PluginContext } from '../lib/plugins/types.ts';

import {
  createReadingStatusPlugin,
  unitOf,
  READING_STATUS_REGION,
  type ReadingStatusSettings,
} from '../plugins/reading-status/plugin.ts';

/**
 * `contextOf` hands back a context with the schema erased — the host keeps one
 * array of plugins with different settings — so the type has to be put back to
 * read `showStats` as a boolean. The erasure is the registry's, not this
 * plugin's, and the cast is confined to the test.
 */
const contextOf = (host: PluginHost) =>
  host.contextOf('reading-status') as unknown as PluginContext<ReadingStatusSettings>;

const NOTHING = () => null;

before(() => {
  const dom = new JSDOM('<div id="mdv-root"><main class="mdv-body"></main></div>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
});

function memoryStorage(): HostStorage {
  let value: unknown = null;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

let host: PluginHost;
let storage: HostStorage;

beforeEach(async () => {
  storage = memoryStorage();
  host = new PluginHost({
    plugins: [createReadingStatusPlugin(NOTHING)],
    storage,
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
});

const keys = () => host.regions.for(READING_STATUS_REGION).map((entry) => entry.key);

/* -------------------------------------------------------------------------- */

test('the readout lands in a region the shell publishes, not one of its own', () => {
  // `document.after` is a core region, so it exists without anyone declaring
  // it — which is the point of contributing rather than rendering.
  assert.deepEqual(keys(), ['reading']);
  assert.deepEqual(
    host.regions.for(READING_STATUS_REGION).map((entry) => entry.pluginId),
    ['reading-status'],
  );
});

test('exactly one thing is contributed — a second would be a second column', () => {
  // Everything in `document.after` is a child of the shell's flex row, and
  // `.mdv > :not(nav)` in viewer.css grants each one `flex: 1 1 auto`. The
  // readout survives that by being `position: fixed`; a second element would
  // not necessarily.
  assert.equal(host.regions.for(READING_STATUS_REGION).length, 1);
});

test('disabling takes the contribution with it, and re-enabling brings one back', async () => {
  await host.setEnabled('reading-status', false);
  assert.deepEqual(keys(), []);

  await host.setEnabled('reading-status', true);
  assert.deepEqual(keys(), ['reading']);
});

test('toggling repeatedly neither duplicates the readout nor strands it', async () => {
  for (let round = 0; round < 4; round += 1) {
    await host.setEnabled('reading-status', false);
    await host.setEnabled('reading-status', true);
  }

  assert.deepEqual(keys(), ['reading']);
  assert.equal(
    host.statuses().every((status) => status.failure === undefined),
    true,
  );
});

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

test('both halves are on by default and are this plugin`s own namespace', async () => {
  const ctx = contextOf(host);
  assert.deepEqual({ ...ctx.settings }, { showStats: true, showProgress: true });

  await ctx.updateSettings({ showProgress: false });
  assert.deepEqual({ ...ctx.settings }, { showStats: true, showProgress: false });

  const stored = (await storage.read()) as {
    plugins: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(stored.plugins['reading-status'], {
    showStats: true,
    showProgress: false,
  });
});

test('a stored setting of the wrong type falls back rather than reaching the bar', async () => {
  const hostile = memoryStorage();
  await hostile.write({
    version: 1,
    global: {},
    // A settings file is user-supplied input.
    plugins: { 'reading-status': { showStats: 'yes please', showProgress: 0 } },
  });

  const fresh = new PluginHost({
    plugins: [createReadingStatusPlugin(NOTHING)],
    storage: hostile,
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  await fresh.start();

  assert.deepEqual({ ...contextOf(fresh).settings }, {
    showStats: true,
    showProgress: true,
  });
});

/* -------------------------------------------------------------------------- */
/* What the number is called                                                   */
/* -------------------------------------------------------------------------- */

test('a CJK-majority document counts characters, not words', () => {
  // CJK text is counted per character, so calling the total "words" on a
  // Chinese or Japanese document would be a plain misstatement.
  assert.equal(unitOf({ words: 500, cjkCharacters: 400, codeBlocks: 0, minutes: 2 }), 'characters');
  assert.equal(unitOf({ words: 500, cjkCharacters: 40, codeBlocks: 0, minutes: 2 }), 'words');
  // Exactly half is not a majority.
  assert.equal(unitOf({ words: 500, cjkCharacters: 250, codeBlocks: 0, minutes: 2 }), 'words');
  assert.equal(unitOf({ words: 0, cjkCharacters: 0, codeBlocks: 0, minutes: 0 }), 'words');
});
