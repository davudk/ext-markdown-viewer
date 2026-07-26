/**
 * The command palette, end to end through the real host.
 *
 * Two things are worth a test here and the second is the point of the whole
 * step. The first is ordinary: one overlay, a restart rather than a second one,
 * a command of its own, nothing left behind.
 *
 * The second is `paletteCommands`. Every ability the palette offers is now a
 * capability, and every absent capability removes its row — which is the rule
 * `buildCommands` has always had, except that until now the answers came from
 * props `Viewer.tsx` never filled in, so "Export as HTML" and "Compare files…"
 * were in `PALETTE_COMMANDS` and had never once appeared in the list. That is
 * exactly the kind of thing that is invisible until someone reads the code, so
 * it is asserted from both sides: present when the provider is, gone when it is
 * not.
 *
 * The panel is a stub — `node --experimental-strip-types` refuses a `.tsx` file
 * outright, which is why the mapping lives in `plugin.ts` at all.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { DEFAULT_SETTINGS } from '../lib/config.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { CORE_REGIONS, type AnyPlugin } from '../lib/plugins/types.ts';

let createCommandPalettePlugin: typeof import('../plugins/command-palette/plugin.ts').createCommandPalettePlugin;
let paletteCommands: typeof import('../plugins/command-palette/plugin.ts').paletteCommands;
let PALETTE_COMMAND: string;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<main class="mdv-body">hello</main>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  ({ createCommandPalettePlugin, paletteCommands, PALETTE_COMMAND } = await import(
    '../plugins/command-palette/plugin.ts'
  ));
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
  return createCommandPalettePlugin({ Panel: stub });
}

async function start() {
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
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One\n\nhello\n',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });

  return { host, shared };
}

function press(key: string, init: { ctrl?: boolean; target?: EventTarget } = {}) {
  const target = init.target ?? dom.window.document.body;
  target.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key,
      ctrlKey: init.ctrl ?? false,
      bubbles: true,
    }),
  );
}

const panels = (host: PluginHost) => host.overlays.store.get();

/* -------------------------------------------------------------------------- */
/* Opening                                                                     */
/* -------------------------------------------------------------------------- */

test('ctrl/cmd+K opens exactly one palette, however often it is pressed', async () => {
  const { host } = await start();

  press('k', { ctrl: true });
  assert.equal(panels(host).length, 1);
  assert.equal(panels(host)[0].label, 'Command palette');

  press('k', { ctrl: true });
  press('K', { ctrl: true });
  assert.equal(panels(host).length, 1, 'a second palette was stacked on the first');
  // A re-press is "start again", not "do nothing" — the panel selects its
  // standing query off this counter, because `openOverlay` cannot say it.
  assert.equal(host.capabilities.use('command-palette')?.restarts.get(), 2);
});

test('it is honoured from inside a field, which is how a reader escapes one', async () => {
  const { host } = await start();

  const field = dom.window.document.createElement('input');
  dom.window.document.body.append(field);
  press('k', { ctrl: true, target: field });
  field.remove();

  assert.equal(panels(host).length, 1);
});

test('it contributes its own command, and stops being special for it', async () => {
  const { host } = await start();

  const command = host.commands.all().find((entry) => entry.id === PALETTE_COMMAND);
  assert.ok(command, 'the palette is not in its own list');

  await command.run();
  assert.equal(panels(host).length, 1);
});

test('the settings it hands its panel are real ones, not a blank', async () => {
  const { host } = await start();

  // Storage is unreachable in a bare node run, which is the same failure the
  // renderer survives: defaults are a working palette.
  assert.equal(
    host.capabilities.use('command-palette')?.settings.get().theme,
    DEFAULT_SETTINGS.theme,
  );
});

test('it stays open over the raw view, which is how a reader gets back out', async () => {
  const { host, shared } = await start();

  press('k', { ctrl: true });
  shared.update({
    body: null,
    source: '# One',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: true,
  });

  assert.equal(panels(host).length, 1, 'the palette closed on the raw toggle');
});

/* -------------------------------------------------------------------------- */
/* Rows follow capabilities                                                    */
/* -------------------------------------------------------------------------- */

const BASE = {
  settings: { ...DEFAULT_SETTINGS },
  applySettings: () => {},
  showRaw: false,
  print: () => {},
};

const titles = (rows: readonly { title: string }[]) => rows.map((row) => row.title);

test('the export rows are absent without the export capability', () => {
  const rows = titles(paletteCommands({ ...BASE }));

  assert.equal(
    rows.some((title) => /^Export/.test(title)),
    false,
    'the palette offered an export with nothing behind it',
  );
});

test('the export rows appear the moment the export plugin provides one', () => {
  let ran: string | null = null;
  const rows = paletteCommands({
    ...BASE,
    exporter: {
      formats: ['html', 'docx'],
      status: { get: () => ({ state: 'idle' }) } as never,
      run: async (format) => {
        ran = format;
      },
    },
  });

  const html = rows.find((row) => row.id === 'command:export-html');
  assert.ok(html, 'no HTML export row');
  assert.ok(rows.some((row) => row.id === 'command:export-docx'), 'no Word export row');

  // And the row is wired to the capability, not to a handler of its own.
  html.run();
  assert.equal(ran, 'html');
});

test('a format the exporter cannot write gets no row', () => {
  const rows = paletteCommands({
    ...BASE,
    exporter: {
      formats: ['html'],
      status: { get: () => ({ state: 'idle' }) } as never,
      run: async () => {},
    },
  });

  assert.ok(rows.some((row) => row.id === 'command:export-html'));
  assert.equal(
    rows.some((row) => row.id === 'command:export-docx'),
    false,
    'a format the add-on cannot produce was offered anyway',
  );
});

test('comparing needs both the diff capability and an open folder', () => {
  const differ = {
    target: { get: () => null } as never,
    compare: () => {},
    start: () => {},
    choose: () => {},
  };
  const openFolder = { supported: true, rootName: 'notes', choose: () => {} };
  const noFolder = { supported: true, rootName: null, choose: () => {} };
  const has = (input: Parameters<typeof paletteCommands>[0]) =>
    paletteCommands(input).some((row) => row.id === 'command:compare-files');

  assert.equal(has({ ...BASE }), false, 'offered with neither');
  assert.equal(has({ ...BASE, differ }), false, 'offered with nothing to compare against');
  assert.equal(has({ ...BASE, folder: openFolder }), false, 'offered with nothing to compare with');
  assert.equal(has({ ...BASE, differ, folder: noFolder }), false, 'offered with no folder open');
  assert.equal(has({ ...BASE, differ, folder: openFolder }), true, 'never offered at all');
});

test('the raw toggle row follows the shell capability, and says which view it is', () => {
  assert.equal(
    titles(paletteCommands({ ...BASE })).some((title) => /raw/i.test(title)),
    false,
    'offered a view switch the shell cannot make',
  );

  const rows = paletteCommands({ ...BASE, showRaw: true, toggleRaw: () => {} });
  const row = rows.find((entry) => entry.id === 'command:toggle-raw');
  assert.ok(row);
  assert.equal(row.hint, 'Raw');
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

test('disabling the plugin leaves no palette, command, capability or binding', async () => {
  const { host } = await start();

  press('k', { ctrl: true });
  assert.equal(panels(host).length, 1);

  await host.setEnabled('command-palette', false);

  assert.equal(panels(host).length, 0, 'the palette outlived the plugin');
  assert.equal(host.commands.all().length, 0, 'the command stayed');
  assert.equal(host.capabilities.use('command-palette'), undefined);

  press('k', { ctrl: true });
  assert.equal(panels(host).length, 0, 'the key binding survived teardown');
});

test('toggling repeatedly leaves exactly one of everything', async () => {
  const { host } = await start();

  for (let i = 0; i < 4; i += 1) {
    press('k', { ctrl: true });
    await host.setEnabled('command-palette', false);
    await host.setEnabled('command-palette', true);
  }

  assert.equal(
    host.commands.all().filter((entry) => entry.id === PALETTE_COMMAND).length,
    1,
    'duplicate commands',
  );
  assert.equal(host.capabilities.use('command-palette')?.restarts.get(), 0);

  press('k', { ctrl: true });
  assert.equal(panels(host).length, 1);
  press('k', { ctrl: true });
  assert.equal(panels(host).length, 1, 'a duplicate binding stacked a second palette');
});

test('a disabled plugin registers nothing at all', async () => {
  const storage = memoryStorage();
  await storage.write({
    version: 1,
    global: {},
    plugins: { 'command-palette': { enabled: false } },
  });

  const host = new PluginHost({
    plugins: [makePlugin()],
    storage,
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  for (const region of CORE_REGIONS) host.regions.declare(region);
  running.push(host);
  await host.start();

  press('k', { ctrl: true });

  assert.equal(panels(host).length, 0);
  assert.equal(host.commands.all().length, 0);
  assert.equal(host.capabilities.use('command-palette'), undefined);
});
