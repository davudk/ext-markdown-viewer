/**
 * Typography through the real host.
 *
 * Two claims: the custom properties land on the root while the plugin is
 * enabled, and they are *removed* when it is not — an injected style that
 * survives teardown is residue in the most literal sense, and the reader who
 * turned the plugin off would keep its font size forever.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { CONTENT_WIDTH_CH, FONT_STACKS, VIEWER_CSS_VARS } from '../lib/config.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let typographyPlugin: typeof import('../plugins/typography/index.ts').typographyPlugin;
let resolveTypography: typeof import('../plugins/typography/index.ts').resolveTypography;
let dom: JSDOM;
let stored: Record<string, unknown> = {};

before(async () => {
  dom = new JSDOM('<main class="mdv-body"></main>', { url: 'https://example.test/a.md' });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'location']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  globals.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: stored[key] };
        },
        async set(patch: Record<string, unknown>) {
          Object.assign(stored, patch);
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };

  ({ typographyPlugin, resolveTypography } = await import('../plugins/typography/index.ts'));
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
  const host = new PluginHost({
    plugins: [typographyPlugin],
    storage: memoryStorage(),
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  return host;
}

const root = () => dom.window.document.documentElement;
const declared = () =>
  Object.values(VIEWER_CSS_VARS).filter(
    (property) => root().style.getPropertyValue(property) !== '',
  );

test('a global overrides the stored setting, and an ill-typed one does not', () => {
  const base = { fontSize: 16, contentWidth: 'normal' } as never;

  assert.equal(resolveTypography(base, { fontSize: 22 }).fontSize, 22);
  assert.equal(resolveTypography(base, { fontSize: '22' }).fontSize, 16);
  assert.equal(resolveTypography(base, {}).fontSize, 16);
});

test('enabling declares the properties and disabling removes every one', async () => {
  stored = { settings: { fontSize: 21, fontFamily: 'serif', contentWidth: 'wide' } };

  const host = harness();
  await host.start();
  // The stored read is a promise; the first paint is synchronous with defaults.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(declared().length, Object.keys(VIEWER_CSS_VARS).length);
  assert.equal(root().style.getPropertyValue(VIEWER_CSS_VARS.fontSize), '21px');
  assert.equal(
    root().style.getPropertyValue(VIEWER_CSS_VARS.fontFamily),
    FONT_STACKS.serif,
  );
  assert.equal(
    root().style.getPropertyValue(VIEWER_CSS_VARS.contentWidth),
    CONTENT_WIDTH_CH.wide,
  );

  await host.setEnabled('typography', false);
  assert.deepEqual(declared(), [], 'a disabled plugin left a custom property behind');
});

test('toggling repeatedly leaves no residue', async () => {
  stored = { settings: {} };
  const host = harness();
  await host.start();

  for (let i = 0; i < 3; i += 1) {
    await host.setEnabled('typography', false);
    assert.deepEqual(declared(), []);
    await host.setEnabled('typography', true);
    assert.equal(declared().length, Object.keys(VIEWER_CSS_VARS).length);
  }

  await host.stop();
  assert.deepEqual(declared(), []);
});
