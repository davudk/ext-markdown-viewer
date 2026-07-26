/**
 * Theme through the real host.
 *
 * The palette arithmetic is already covered without a browser by
 * `theme-presets.test.ts`. What is asserted here is the plugin's half: it
 * applies the polarity and the preset sheet, it re-resolves the per-document
 * pin when the document under the tab changes (which is the case the shell's
 * pre-paint apply cannot cover, because that URL is not the page's), and it
 * takes both style elements with it when it goes — one element, never a stack
 * of them, however many times it is toggled.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { DOCUMENT_THEME_KEY, SETTINGS_KEY } from '../lib/config.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { CUSTOM_CSS_STYLE_ID, PRESET_STYLE_ID } from '../lib/theme-presets.ts';

let themePlugin: typeof import('../plugins/theme/index.ts').themePlugin;
let dom: JSDOM;
let stored: Record<string, unknown> = {};

const URL_A = 'https://example.test/docs/a.md';

before(async () => {
  dom = new JSDOM('<main class="mdv-body"></main>', { url: URL_A });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'location']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  // jsdom has no matchMedia; the plugin degrades to "the OS is not dark",
  // which is exactly what a light-only environment should resolve to.
  globals.matchMedia = undefined;

  globals.chrome = {
    storage: {
      local: {
        async get(key: string) {
          return { [key]: stored[key] };
        },
        async set(patch: Record<string, unknown>) {
          Object.assign(stored, patch);
        },
        async remove(key: string) {
          delete stored[key];
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };

  ({ themePlugin } = await import('../plugins/theme/index.ts'));
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
    plugins: [themePlugin],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  return { shared, host };
}

function publish(shared: SharedDocument, url: string) {
  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '',
    html: '',
    headings: [],
    url,
    isRaw: false,
  });
}

const styles = (id: string) => dom.window.document.querySelectorAll(`#${id}`).length;
const polarity = () => dom.window.document.documentElement.dataset.mdvTheme;
/** Storage is async everywhere here; let the reads land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('enabling paints the theme; disabling removes the sheets and the attribute', async () => {
  stored = {
    [SETTINGS_KEY]: { theme: 'dark', themePreset: 'default', customCss: 'p { color: red }' },
  };

  const { shared, host } = harness();
  await host.start();
  publish(shared, URL_A);
  await settle();

  assert.equal(polarity(), 'dark');
  assert.equal(styles(PRESET_STYLE_ID), 1);
  assert.equal(styles(CUSTOM_CSS_STYLE_ID), 1);

  await host.setEnabled('theme', false);
  assert.equal(styles(PRESET_STYLE_ID), 0, 'the preset sheet outlived the plugin');
  assert.equal(styles(CUSTOM_CSS_STYLE_ID), 0, 'the custom sheet outlived the plugin');
  assert.equal(polarity(), undefined);
});

test('a per-document pin is re-resolved when the open document changes', async () => {
  stored = {
    [SETTINGS_KEY]: { theme: 'dark', themePreset: 'default', customCss: '' },
    // What the files plugin opens: a URL that is not the page's own, so the
    // renderer's pre-paint resolve could not have seen this pin.
    [DOCUMENT_THEME_KEY]: {
      'mdv-folder:/notes/b.md': {
        override: { theme: 'light', preset: null },
        usedAt: 1,
      },
    },
  };

  const { shared, host } = harness();
  await host.start();
  publish(shared, URL_A);
  await settle();
  assert.equal(polarity(), 'dark');

  publish(shared, 'mdv-folder:/notes/b.md');
  await settle();
  assert.equal(polarity(), 'light', 'the pin for the newly opened document was not applied');

  await host.stop();
});

test('toggling repeatedly leaves one sheet, never a stack', async () => {
  stored = { [SETTINGS_KEY]: { theme: 'light', themePreset: 'default', customCss: 'p{}' } };

  const { shared, host } = harness();
  await host.start();
  publish(shared, URL_A);
  await settle();

  for (let i = 0; i < 3; i += 1) {
    await host.setEnabled('theme', false);
    assert.equal(styles(PRESET_STYLE_ID), 0);
    await host.setEnabled('theme', true);
    publish(shared, URL_A);
    await settle();
    assert.equal(styles(PRESET_STYLE_ID), 1, `sheets stacked on toggle ${i + 1}`);
    assert.equal(styles(CUSTOM_CSS_STYLE_ID), 1);
  }

  await host.stop();
  assert.equal(styles(PRESET_STYLE_ID), 0);
  assert.equal(styles(CUSTOM_CSS_STYLE_ID), 0);
  assert.equal(polarity(), undefined);
});
