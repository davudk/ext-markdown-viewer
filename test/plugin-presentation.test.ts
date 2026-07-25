/**
 * The second migrated plugin, end to end through the real host.
 *
 * This is the pilot for the overlay path, so what is asserted here is mostly
 * teardown: that the deck the host opened is closed, the launcher unmounted,
 * the command withdrawn, the key unbound and the fullscreen given back when the
 * plugin is disabled — and that toggling it repeatedly leaves exactly one of
 * each. A half-teardown is invisible until it is a duplicate listener, which is
 * why the toggle loop is a test rather than a code review note.
 *
 * The views are stubs. Not for isolation: `node --experimental-strip-types`
 * refuses a `.tsx` file outright, so the real components cannot be imported by
 * any test in this suite. Everything with a lifecycle lives in `plugin.ts` for
 * exactly that reason, and that is what runs below.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { CORE_REGIONS, type AnyPlugin } from '../lib/plugins/types.ts';

let createPresentationPlugin: typeof import('../plugins/presentation/plugin.ts').createPresentationPlugin;
let PRESENT_COMMAND: string;
let dom: JSDOM;

/** What the fake Fullscreen API below is currently showing. */
let fullscreenElement: Element | null = null;
let exits = 0;

before(async () => {
  dom = new JSDOM('<main class="mdv-body"></main>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  // jsdom implements no part of the Fullscreen API, and the plugin's ownership
  // of the fullscreen it requested is half of what its teardown has to undo.
  const page = dom.window.document;
  Object.defineProperty(page, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  page.documentElement.requestFullscreen = async () => {
    fullscreenElement = page.documentElement;
  };
  page.exitFullscreen = async () => {
    exits += 1;
    fullscreenElement = null;
  };

  ({ createPresentationPlugin, PRESENT_COMMAND } = await import(
    '../plugins/presentation/plugin.ts'
  ));
});

/**
 * Every host a test started. Stopped between tests, because a host that is
 * still up is still listening on `window` — which is the point of the design
 * and would otherwise make one test's key press open the previous test's deck.
 */
const running: PluginHost[] = [];

beforeEach(async () => {
  for (const host of running.splice(0)) await host.stop();
  fullscreenElement = null;
  exits = 0;
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

/** A component in the type system's eyes, and nothing at all in React's. */
const stub = () => null;

function makePlugin(): AnyPlugin {
  return createPresentationPlugin({ Launcher: stub, Deck: stub });
}

async function start() {
  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [makePlugin()],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  // The shell publishes the core regions; without them a contribution to a
  // corner is inert, which is the correct behaviour and not the one under test.
  for (const region of CORE_REGIONS) host.regions.declare(region);
  running.push(host);
  await host.start();

  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One\n\ntext\n\n## Two\n\nmore\n',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });

  return { host, shared };
}

/** A key press as the reader makes it: from whatever has focus, up to window. */
function press(key: string, target: EventTarget = dom.window.document.body) {
  target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

/** The plugin's fullscreen request resolves on a microtask, not synchronously. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function openDecks(host: PluginHost) {
  return host.overlays.store.get();
}

/* -------------------------------------------------------------------------- */
/* Opening                                                                     */
/* -------------------------------------------------------------------------- */

test('the launcher is contributed to the bottom-end corner', async () => {
  const { host } = await start();

  const placed = host.regions.for('chrome.bottom-end');
  assert.equal(placed.length, 1);
  assert.equal(placed[0].pluginId, 'presentation');
  // Nothing lands anywhere else: the shell has one slot for this button.
  for (const region of CORE_REGIONS) {
    if (region === 'chrome.bottom-end') continue;
    assert.equal(host.regions.for(region).length, 0, `unexpected contribution to ${region}`);
  }
});

test("the split setting is the plugin's own, and defaults to auto", async () => {
  const { host } = await start();

  const ctx = host.contextOf('presentation');
  assert.ok(ctx);

  // The context is typed by the plugin's own schema, which the registry erases
  // to hold plugins with different ones in one array — so the test reads it the
  // way the settings page will have to.
  const split = () => (ctx.settings as unknown as { slideSplit: string }).slideSplit;

  assert.equal(split(), 'auto');

  // Stored nonsense falls back rather than reaching `splitSlides` as a mode it
  // does not implement.
  await ctx.updateSettings({ slideSplit: 'sideways' } as never);
  assert.equal(split(), 'auto');

  await ctx.updateSettings({ slideSplit: 'heading' } as never);
  assert.equal(split(), 'heading');
});

test('the shortcut opens exactly one deck, however often it is pressed', async () => {
  const { host } = await start();

  press('p');
  assert.equal(openDecks(host).length, 1);
  assert.equal(openDecks(host)[0].label, 'Presentation');

  press('p');
  press('P');
  assert.equal(openDecks(host).length, 1, 'a second deck was stacked on the first');
});

test('the shortcut stays out of the way while the reader is typing', async () => {
  const { host } = await start();

  const field = dom.window.document.createElement('input');
  dom.window.document.body.append(field);
  press('p', field);
  field.remove();

  assert.equal(openDecks(host).length, 0);
});

test('the command opens the deck, which is how the launcher does it', async () => {
  const { host } = await start();

  const command = host.commands.all().find((entry) => entry.id === PRESENT_COMMAND);
  assert.ok(command, 'no command for the launcher to run');

  await command.run();
  assert.equal(openDecks(host).length, 1);
});

test('the deck takes the fullscreen it asked for, and gives it back', async () => {
  const { host } = await start();

  press('p');
  await settle();
  assert.equal(fullscreenElement, dom.window.document.documentElement);

  host.overlays.close(openDecks(host)[0].instanceId);
  assert.equal(exits, 1, 'closing the deck left the page in fullscreen');
  assert.equal(fullscreenElement, null);
});

test('losing fullscreen closes the deck, since Escape never reaches a handler', async () => {
  const { host } = await start();

  press('p');
  await settle();

  // What F11 and the browser's own "exit full screen" chip produce.
  fullscreenElement = null;
  dom.window.document.dispatchEvent(new dom.window.Event('fullscreenchange'));

  assert.equal(openDecks(host).length, 0);
});

/* -------------------------------------------------------------------------- */
/* The raw view                                                                */
/* -------------------------------------------------------------------------- */

test('switching to the raw view takes the deck down with it', async () => {
  const { host, shared } = await start();

  press('p');
  assert.equal(openDecks(host).length, 1);

  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: true,
  });

  assert.equal(openDecks(host).length, 0, 'a deck survived over the raw view');
  // And it cannot be opened again from there.
  press('p');
  assert.equal(openDecks(host).length, 0);
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

test('disabling the plugin leaves no deck, launcher, command or binding', async () => {
  const { host } = await start();

  press('p');
  await settle();
  assert.equal(openDecks(host).length, 1);

  await host.setEnabled('presentation', false);

  assert.equal(openDecks(host).length, 0, 'the deck outlived the plugin');
  assert.equal(exits, 1, 'the page was left in fullscreen');
  assert.equal(host.regions.for('chrome.bottom-end').length, 0, 'the launcher stayed');
  assert.equal(
    host.commands.all().filter((entry) => entry.id === PRESENT_COMMAND).length,
    0,
    'the command stayed',
  );

  press('p');
  assert.equal(openDecks(host).length, 0, 'the key binding survived teardown');
});

test('toggling repeatedly leaves exactly one of everything', async () => {
  const { host } = await start();

  for (let i = 0; i < 4; i += 1) {
    press('p');
    await settle();
    await host.setEnabled('presentation', false);
    await host.setEnabled('presentation', true);
  }

  assert.equal(host.regions.for('chrome.bottom-end').length, 1, 'duplicate launchers');
  assert.equal(
    host.commands.all().filter((entry) => entry.id === PRESENT_COMMAND).length,
    1,
    'duplicate commands',
  );

  press('p');
  assert.equal(openDecks(host).length, 1, 'the key opened more than one deck');
});

test('a disabled plugin registers nothing at all', async () => {
  const storage = memoryStorage();
  await storage.write({
    version: 1,
    global: {},
    plugins: { presentation: { enabled: false } },
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

  press('p');

  assert.equal(openDecks(host).length, 0);
  assert.equal(host.regions.for('chrome.bottom-end').length, 0);
  assert.equal(host.commands.all().length, 0);
});

test('fullscreen granted after the deck is gone is handed straight back', async () => {
  const { host } = await start();

  // The browser answers a frame or two later. Closing inside that window used
  // to leave the page full screen with nothing in it.
  press('p');
  host.overlays.close(openDecks(host)[0].instanceId);
  await settle();

  assert.equal(fullscreenElement, null);
  assert.equal(exits, 1);
});
