/**
 * Export, end to end through the real host.
 *
 * The interesting half of this migration is that exporting stopped being React
 * state inside a menu. It is a capability now — `formats` and `run` — which is
 * the whole reason the command palette can offer "Export as HTML" for the first
 * time. So that is what is asserted: the capability is there while the plugin
 * is, it reports honestly when there is nothing to export, and it is withdrawn
 * cleanly with everything else.
 *
 * Nothing here injects the add-on. `run` is only driven down the path that ends
 * before the service worker is asked for anything — a document that is not
 * rendered — because the alternative is a test that depends on `chrome`.
 *
 * The menu is a stub: `node --experimental-strip-types` refuses a `.tsx` file
 * outright, which is why every lifecycle decision lives in `plugin.ts`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { EXPORT_FORMATS } from '../lib/config.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { CORE_REGIONS, type AnyPlugin } from '../lib/plugins/types.ts';

let createExportPlugin: typeof import('../plugins/export/plugin.ts').createExportPlugin;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<main class="mdv-body">hello</main>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  ({ createExportPlugin } = await import('../plugins/export/plugin.ts'));
});

const running: PluginHost[] = [];

beforeEach(async () => {
  for (const host of running.splice(0)) await host.stop();
});

after(async () => {
  for (const host of running.splice(0)) await host.stop();
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

const stub = () => null;

function makePlugin(): AnyPlugin {
  return createExportPlugin({ Menu: stub });
}

/** `rendered: false` is a document the shell has not published a body for. */
async function start({ rendered = true } = {}) {
  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [makePlugin()],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  for (const region of CORE_REGIONS) host.regions.declare(region);
  running.push(host);
  await host.start();

  shared.update({
    body: rendered
      ? (dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement)
      : null,
    source: '# One\n\nhello\n',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });

  return { host, shared };
}

const exporter = (host: PluginHost) => host.capabilities.use('export');

/* -------------------------------------------------------------------------- */
/* What it publishes                                                           */
/* -------------------------------------------------------------------------- */

test('the menu is contributed to the top-end corner and nowhere else', async () => {
  const { host } = await start();

  const placed = host.regions.for('chrome.top-end');
  assert.equal(placed.length, 1);
  assert.equal(placed[0].pluginId, 'export');

  for (const region of CORE_REGIONS) {
    if (region === 'chrome.top-end') continue;
    assert.equal(host.regions.for(region).length, 0, `unexpected contribution to ${region}`);
  }
});

test('the capability offers every format the build can write', async () => {
  const { host } = await start();

  const capability = exporter(host);
  assert.ok(capability, 'nothing for the palette to use');
  assert.deepEqual(
    [...capability.formats],
    EXPORT_FORMATS.map((format) => format.value),
  );
  assert.deepEqual(capability.status.get(), { state: 'idle' });
});

test('no commands are registered — the palette owns the wording of those rows', async () => {
  const { host } = await start();

  // `PALETTE_COMMANDS` already has `export-html` and `export-docx`, with the
  // keywords the matcher is tuned for. A command here as well would put the same
  // action in the list twice under two names.
  assert.deepEqual(host.commands.all(), []);
});

/* -------------------------------------------------------------------------- */
/* Running it                                                                  */
/* -------------------------------------------------------------------------- */

test('exporting a document that is not rendered fails, and says so', async () => {
  const { host } = await start({ rendered: false });

  const capability = exporter(host);
  assert.ok(capability);

  await capability.run('html');

  const status = capability.status.get();
  assert.equal(status.state, 'failed');
  assert.match(
    status.state === 'failed' ? status.message : '',
    /not rendered/,
    'the reader was not told why nothing happened',
  );
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

test('disabling the plugin withdraws the capability and the menu', async () => {
  const { host } = await start({ rendered: false });

  // Leave a result timer running, so the teardown has something to clear.
  await exporter(host)!.run('html');

  await host.setEnabled('export', false);

  assert.equal(exporter(host), undefined, 'the capability outlived the plugin');
  assert.equal(host.regions.for('chrome.top-end').length, 0, 'the menu stayed');
});

test('toggling repeatedly leaves exactly one of everything, and a clean status', async () => {
  const { host } = await start({ rendered: false });

  for (let i = 0; i < 4; i += 1) {
    await exporter(host)!.run('html');
    await host.setEnabled('export', false);
    await host.setEnabled('export', true);
  }

  assert.equal(host.regions.for('chrome.top-end').length, 1, 'duplicate menus');
  assert.equal(host.commands.all().length, 0, 'commands accumulated');

  const capability = exporter(host);
  assert.ok(capability);
  // A fresh store per enable: a failure message carried across a disable would
  // be announced by a menu that has just mounted, about an export nobody ran.
  assert.deepEqual(capability.status.get(), { state: 'idle' });
});

test('a disabled plugin registers nothing at all', async () => {
  const storage = memoryStorage();
  await storage.write({ version: 1, global: {}, plugins: { export: { enabled: false } } });

  const host = new PluginHost({
    plugins: [makePlugin()],
    storage,
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  for (const region of CORE_REGIONS) host.regions.declare(region);
  running.push(host);
  await host.start();

  assert.equal(host.capabilities.use('export'), undefined);
  assert.equal(host.regions.for('chrome.top-end').length, 0);
});
