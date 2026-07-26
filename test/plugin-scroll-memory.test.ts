/**
 * Scroll memory through the real host.
 *
 * The claim under test is the teardown contract, not the arithmetic — the
 * encoding is already covered by `document-state.test.ts` without a DOM. What
 * this asserts is that enabling attaches exactly three listeners, disabling
 * removes exactly those three, and doing it repeatedly accumulates nothing.
 * `restoring on every enable, detaching once` is the failure mode that looks
 * fine until the third toggle.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let scrollMemoryPlugin: typeof import('../plugins/scroll-memory/index.ts').scrollMemoryPlugin;
let dom: JSDOM;
/** Every listener currently attached by the plugin, as `target:type`. */
let attached: string[] = [];

const URL_A = 'https://example.test/docs/a.md';

before(async () => {
  dom = new JSDOM('<main class="mdv-body"><h1 id="one">One</h1></main>', { url: URL_A });

  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'location']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  // jsdom's own scrollTo logs a not-implemented error; the restore only has to
  // be observed to have happened.
  dom.window.scrollTo = (() => {}) as never;

  // Storage is a plain object, as in document-state.test.ts.
  const store: Record<string, unknown> = {};
  globals.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: store[key] };
        },
        async set(patch: Record<string, unknown>) {
          Object.assign(store, patch);
        },
        async remove(key: string) {
          delete store[key];
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };

  for (const [label, target] of [
    ['window', dom.window],
    ['document', dom.window.document],
  ] as const) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = ((type: string, fn: never, options: never) => {
      attached.push(`${label}:${type}`);
      add(type, fn, options);
    }) as never;
    target.removeEventListener = ((type: string, fn: never, options: never) => {
      const index = attached.indexOf(`${label}:${type}`);
      if (index >= 0) attached.splice(index, 1);
      remove(type, fn, options);
    }) as never;
  }

  ({ scrollMemoryPlugin } = await import('../plugins/scroll-memory/index.ts'));
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

function harness() {
  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [scrollMemoryPlugin],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  return { shared, host };
}

function publish(shared: SharedDocument, isRaw = false) {
  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One',
    html: '',
    headings: [],
    url: URL_A,
    isRaw,
  });
}

/** The three listeners the feature is made of, in the order it attaches them. */
const EXPECTED = ['window:scroll', 'document:visibilitychange', 'window:pagehide'];

test('enabling attaches the listeners and disabling leaves none behind', async () => {
  attached = [];
  const { shared, host } = harness();

  await host.start();
  publish(shared);
  assert.deepEqual(attached, EXPECTED);

  await host.setEnabled('scroll-memory', false);
  assert.deepEqual(attached, [], 'a disabled plugin left a listener attached');
});

test('toggling repeatedly accumulates nothing', async () => {
  attached = [];
  const { shared, host } = harness();

  await host.start();
  publish(shared);

  for (let i = 0; i < 3; i += 1) {
    await host.setEnabled('scroll-memory', false);
    assert.deepEqual(attached, []);
    await host.setEnabled('scroll-memory', true);
    publish(shared);
    assert.deepEqual(attached, EXPECTED, `listeners doubled on toggle ${i + 1}`);
  }

  await host.setEnabled('scroll-memory', false);
  assert.deepEqual(attached, []);
});

test('the raw view is not measured, and going back to rendered restarts it', async () => {
  attached = [];
  const { shared, host } = harness();

  await host.start();
  publish(shared, true);
  assert.deepEqual(attached, [], 'the raw view has no headings to measure against');

  publish(shared, false);
  assert.deepEqual(attached, EXPECTED);

  await host.stop();
  assert.deepEqual(attached, []);
});
