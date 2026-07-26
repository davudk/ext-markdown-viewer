/**
 * Document comparison, end to end through the real host.
 *
 * Most of what this asserts is what the overlay manager took over. The old
 * component portalled itself onto `<body>` twice, set `inert` on `#mdv-root`,
 * ran a `focusin` backstop and a Tab trap, handled its own Escape and picked
 * `z-index: 2147483000` for both surfaces — none of which is here any more, so
 * what is left to prove is that the *stack* is right: one overlay at a time, the
 * menu handing off to the comparison without an empty frame between them, and
 * nothing outliving the plugin.
 *
 * The scroll lock is the exception the plugin still owns, so it is tested
 * directly: it is the one thing `OverlayOptions` cannot express.
 *
 * The three views are stubs. `node --experimental-strip-types` refuses a `.tsx`
 * file outright, which is why every lifecycle decision lives in `plugin.ts`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import type { CompareRequest } from '../lib/diff.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { CORE_REGIONS, type AnyPlugin } from '../lib/plugins/types.ts';

let createDiffPlugin: typeof import('../plugins/diff/plugin.ts').createDiffPlugin;
let DIFF_MENU_OVERLAY: string;
let DIFF_PICKER_OVERLAY: string;
let DIFF_VIEW_OVERLAY: string;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<main class="mdv-body">hello</main>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  ({ createDiffPlugin, DIFF_MENU_OVERLAY, DIFF_PICKER_OVERLAY, DIFF_VIEW_OVERLAY } =
    await import('../plugins/diff/plugin.ts'));
});

const running: PluginHost[] = [];

beforeEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  dom.window.document.documentElement.style.overflow = '';
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
  return createDiffPlugin({ Menu: stub, Picker: stub, View: stub });
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

  publish(shared, false);
  return { host, shared };
}

function publish(shared: SharedDocument, isRaw: boolean) {
  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One\n\nhello\n',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw,
  });
}

/** A request as the Files tab makes one: a name, a path, and a thunk. */
function request(name = 'b.md'): CompareRequest {
  return {
    name,
    path: `docs/${name}`,
    read: async () => '# Two\n',
    anchor: { x: 10, y: 20 },
    origin: null,
  };
}

const overlays = (host: PluginHost) => host.overlays.store.get();
const ids = (host: PluginHost) => overlays(host).map((entry) => entry.id);
const differ = (host: PluginHost) => host.capabilities.use('diff');
const overflow = () => dom.window.document.documentElement.style.overflow;

/** `onClose` defers its "is anything still showing" check by a microtask. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* -------------------------------------------------------------------------- */
/* What it publishes                                                           */
/* -------------------------------------------------------------------------- */

test('it provides both the diff capability and document.compare', async () => {
  const { host } = await start();

  assert.ok(differ(host), 'nothing for the palette to use');
  // The Files tab calls `document.compare` and does not learn that the shell
  // stopped being the one who answers it.
  assert.equal(typeof host.capabilities.use('document.compare'), 'function');
});

test('it contributes no UI and no command', async () => {
  const { host } = await start();

  for (const region of CORE_REGIONS) {
    assert.equal(host.regions.for(region).length, 0, `unexpected contribution to ${region}`);
  }
  // `PALETTE_COMMANDS` already carries the `compare-files` row; a command here
  // would be the same action listed twice.
  assert.deepEqual(host.commands.all(), []);
});

/* -------------------------------------------------------------------------- */
/* The stack                                                                   */
/* -------------------------------------------------------------------------- */

test('a compare request raises the row menu, and only that', async () => {
  const { host } = await start();

  host.capabilities.use('document.compare')!(request());

  assert.deepEqual(ids(host), [DIFF_MENU_OVERLAY]);
  assert.equal(differ(host)!.target.get()?.name, 'b.md');
  // Nothing is read and no library is loaded yet: a right-click is a question.
  assert.equal(overflow(), '', 'the page was locked before the reader chose anything');
});

test('a second request replaces the first rather than stacking on it', async () => {
  const { host } = await start();

  differ(host)!.compare(request('b.md'));
  differ(host)!.compare(request('c.md'));
  await settle();

  assert.deepEqual(ids(host), [DIFF_MENU_OVERLAY]);
  assert.equal(differ(host)!.target.get()?.name, 'c.md');
});

test('choosing the item swaps the menu for the comparison, and locks the page', async () => {
  const { host } = await start();

  differ(host)!.compare(request());
  differ(host)!.start();
  await settle();

  assert.deepEqual(ids(host), [DIFF_VIEW_OVERLAY]);
  // The menu closing must not clear the target the comparison is about to read.
  assert.equal(differ(host)!.target.get()?.name, 'b.md');
  assert.equal(overflow(), 'hidden', 'the page scrolled behind the comparison');
});

test('closing the comparison clears the target and gives the page back', async () => {
  const { host } = await start();

  differ(host)!.compare(request());
  differ(host)!.start();
  await settle();

  host.overlays.close(overlays(host)[0].instanceId);
  await settle();

  assert.deepEqual(ids(host), []);
  assert.equal(differ(host)!.target.get(), null);
  assert.equal(overflow(), '', 'the page was left locked');
});

test('dismissing the menu without choosing clears the target', async () => {
  const { host } = await start();

  differ(host)!.compare(request());
  host.overlays.close(overlays(host)[0].instanceId);
  await settle();

  assert.deepEqual(ids(host), []);
  assert.equal(differ(host)!.target.get(), null);
});

test('the palette route opens the picker instead of a menu', async () => {
  const { host } = await start();

  differ(host)!.choose();

  assert.deepEqual(ids(host), [DIFF_PICKER_OVERLAY]);
  // Nothing is pointed at yet — the picker is where that is decided.
  assert.equal(differ(host)!.target.get(), null);
});

test('starting with nothing pointed at does nothing at all', async () => {
  const { host } = await start();

  differ(host)!.start();

  assert.deepEqual(ids(host), []);
  assert.equal(overflow(), '');
});

/* -------------------------------------------------------------------------- */
/* The document moving underneath                                              */
/* -------------------------------------------------------------------------- */

test('a new document takes the comparison down with it', async () => {
  const { host, shared } = await start();

  differ(host)!.compare(request());
  differ(host)!.start();
  await settle();
  assert.deepEqual(ids(host), [DIFF_VIEW_OVERLAY]);

  // Live reload, or the raw toggle: two panes describing a document that is no
  // longer on screen are two panes describing nothing.
  publish(shared, true);
  await settle();

  assert.deepEqual(ids(host), []);
  assert.equal(overflow(), '', 'the page was left locked under a closed comparison');
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

test('disabling the plugin leaves no overlay, capability or scroll lock', async () => {
  const { host } = await start();

  differ(host)!.compare(request());
  differ(host)!.start();
  await settle();

  await host.setEnabled('diff', false);
  await settle();

  assert.deepEqual(ids(host), [], 'a surface outlived the plugin');
  assert.equal(host.capabilities.use('diff'), undefined, 'the capability stayed');
  assert.equal(
    host.capabilities.use('document.compare'),
    undefined,
    'the Files tab was left raising menus nothing answers',
  );
  assert.equal(overflow(), '', 'the page was left locked');
});

test('toggling repeatedly leaves exactly one of everything', async () => {
  const { host } = await start();

  for (let i = 0; i < 4; i += 1) {
    differ(host)!.compare(request());
    differ(host)!.start();
    await settle();
    await host.setEnabled('diff', false);
    await host.setEnabled('diff', true);
    await settle();
  }

  assert.equal(overflow(), '');
  assert.equal(differ(host)!.target.get(), null);

  differ(host)!.compare(request());
  assert.equal(overlays(host).length, 1, 'a duplicate registration stacked a second menu');
});

test('a disabled plugin registers nothing at all', async () => {
  const storage = memoryStorage();
  await storage.write({ version: 1, global: {}, plugins: { diff: { enabled: false } } });

  const host = new PluginHost({
    plugins: [makePlugin()],
    storage,
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  for (const region of CORE_REGIONS) host.regions.declare(region);
  running.push(host);
  await host.start();

  assert.equal(host.capabilities.use('diff'), undefined);
  assert.equal(host.capabilities.use('document.compare'), undefined);
  assert.deepEqual(overlays(host), []);
});
