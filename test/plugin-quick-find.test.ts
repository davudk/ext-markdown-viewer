/**
 * Quick find, end to end through the real host.
 *
 * What is asserted here is almost entirely the part that moved *out* of the
 * panel. The panel used to own "am I open" — a piece of state, a ref, a window
 * listener, two key bindings, an Escape branch and a focus restore — and every
 * one of those is now the host's. So what is left to test is the plugin: that
 * the two keys open exactly one overlay, that a second press restarts rather
 * than stacks or closes, that the raw view takes it down, and that disabling
 * leaves no overlay, no command, no capability and no live binding.
 *
 * The panel is a stub. Not for isolation: `node --experimental-strip-types`
 * refuses a `.tsx` file outright, so the real component cannot be imported by
 * any test in this suite. Everything with a lifecycle lives in `plugin.ts` for
 * exactly that reason, and that is what runs below.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { CORE_REGIONS, type AnyPlugin } from '../lib/plugins/types.ts';

let createQuickFindPlugin: typeof import('../plugins/quick-find/plugin.ts').createQuickFindPlugin;
let QUICK_FIND_COMMAND: string;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<main class="mdv-body">hello</main>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  ({ createQuickFindPlugin, QUICK_FIND_COMMAND } = await import(
    '../plugins/quick-find/plugin.ts'
  ));
});

/**
 * Every host a test started. Stopped between tests, because a host that is still
 * up is still listening on `window` — which is the point of the design and would
 * otherwise make one test's key press open the previous test's panel.
 */
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

/** A component in the type system's eyes, and nothing at all in React's. */
const stub = () => null;

function makePlugin(): AnyPlugin {
  return createQuickFindPlugin({ Panel: stub });
}

async function start({ raw = false } = {}) {
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
    isRaw: raw,
  });

  return { host, shared };
}

/** A key press as the reader makes it: from whatever has focus, up to window. */
function press(
  key: string,
  init: { ctrl?: boolean; target?: EventTarget } = {},
) {
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

function restarts(host: PluginHost): number {
  return host.capabilities.use('quick-find')?.restarts.get() ?? -1;
}

/* -------------------------------------------------------------------------- */
/* Opening                                                                     */
/* -------------------------------------------------------------------------- */

test('ctrl/cmd+F opens exactly one panel, however often it is pressed', async () => {
  const { host } = await start();

  press('f', { ctrl: true });
  assert.equal(panels(host).length, 1);
  assert.equal(panels(host)[0].label, 'Find in document');

  press('f', { ctrl: true });
  press('F', { ctrl: true });
  assert.equal(panels(host).length, 1, 'a second panel was stacked on the first');
  // Not a no-op either: a re-press means "start a new search", and the panel
  // selects its standing query off this counter.
  assert.equal(restarts(host), 2);
});

test('ctrl/cmd+F is honoured from inside a field, and `/` is not', async () => {
  const { host } = await start();

  const field = dom.window.document.createElement('input');
  dom.window.document.body.append(field);

  // The takeover of the browser's own find bar is only honest if it is
  // unconditional, and a modified F is never part of what somebody is typing.
  press('f', { ctrl: true, target: field });
  assert.equal(panels(host).length, 1);

  host.overlays.close(panels(host)[0].instanceId);

  // `/` is a bare key and belongs to whatever has focus: stealing it would make
  // the field impossible to type a path into.
  press('/', { target: field });
  assert.equal(panels(host).length, 0);
  field.remove();
});

test('`/` opens the panel from the document', async () => {
  const { host } = await start();

  press('/');
  assert.equal(panels(host).length, 1);
});

test('the command opens it, which is how the palette does', async () => {
  const { host } = await start();

  const command = host.commands.all().find((entry) => entry.id === QUICK_FIND_COMMAND);
  assert.ok(command, 'no command for the palette to list');

  await command.run();
  assert.equal(panels(host).length, 1);
});

/* -------------------------------------------------------------------------- */
/* The raw view                                                                */
/* -------------------------------------------------------------------------- */

test('the raw view has nothing to find in, so the panel neither opens nor stays', async () => {
  const { host, shared } = await start();

  press('/');
  assert.equal(panels(host).length, 1);

  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: true,
  });

  assert.equal(panels(host).length, 0, 'a panel survived over the raw view');
  press('/');
  press('f', { ctrl: true });
  assert.equal(panels(host).length, 0, 'the panel opened over the raw view');
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

test('disabling the plugin leaves no panel, command, capability or binding', async () => {
  const { host } = await start();

  press('/');
  assert.equal(panels(host).length, 1);

  await host.setEnabled('quick-find', false);

  assert.equal(panels(host).length, 0, 'the panel outlived the plugin');
  assert.equal(
    host.commands.all().filter((entry) => entry.id === QUICK_FIND_COMMAND).length,
    0,
    'the command stayed',
  );
  assert.equal(host.capabilities.use('quick-find'), undefined, 'the capability stayed');

  press('/');
  press('f', { ctrl: true });
  assert.equal(panels(host).length, 0, 'a key binding survived teardown');
});

test('toggling repeatedly leaves exactly one of everything', async () => {
  const { host } = await start();

  for (let i = 0; i < 4; i += 1) {
    press('/');
    await host.setEnabled('quick-find', false);
    await host.setEnabled('quick-find', true);
  }

  assert.equal(
    host.commands.all().filter((entry) => entry.id === QUICK_FIND_COMMAND).length,
    1,
    'duplicate commands',
  );
  // A restart counter that survived a disable would have the panel selecting its
  // query on the render it opens.
  assert.equal(restarts(host), 0);

  press('/');
  assert.equal(panels(host).length, 1, 'the key opened more than one panel');
  press('/');
  assert.equal(panels(host).length, 1, 'a duplicate binding stacked a second panel');
});

test('a disabled plugin registers nothing at all', async () => {
  const storage = memoryStorage();
  await storage.write({
    version: 1,
    global: {},
    plugins: { 'quick-find': { enabled: false } },
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

  press('/');
  press('f', { ctrl: true });

  assert.equal(panels(host).length, 0);
  assert.equal(host.commands.all().length, 0);
  assert.equal(host.capabilities.use('quick-find'), undefined);
});
