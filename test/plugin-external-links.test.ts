/**
 * The first migrated plugin, end to end through the real host.
 *
 * The unit tests prove the host's contracts against stub plugins; this proves
 * the contracts hold for an actual feature — that enabling it marks the
 * document, and that disabling it leaves nothing behind. That second half is
 * the claim the whole architecture rests on, so it is asserted on a real DOM
 * rather than on a spy.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let externalLinksPlugin: typeof import('../plugins/external-links/index.ts').externalLinksPlugin;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<main class="mdv-body"></main>', { url: 'https://example.test/docs/a.md' });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  // No rAF under the bare runner, so SharedDocument runs passes inline — which
  // is what makes the assertions below synchronous.
  ({ externalLinksPlugin } = await import('../plugins/external-links/index.ts'));
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

function setBody(html: string) {
  const body = dom.window.document.querySelector('main.mdv-body')!;
  body.innerHTML = html;
  return body as unknown as HTMLElement;
}

test('the plugin marks external links and only external links', async () => {
  const body = setBody(`
    <p>
      <a href="https://elsewhere.example/page">away</a>
      <a href="#section">in-page</a>
      <a href="./sibling.md">relative</a>
      <a href="mailto:someone@example.test">mail</a>
    </p>
  `);

  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [externalLinksPlugin],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  await host.start();
  shared.update({
    body,
    source: '',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });

  const marked = [...body.querySelectorAll('a[data-mdv-external]')].map((a) =>
    a.getAttribute('href'),
  );
  assert.deepEqual(marked, ['https://elsewhere.example/page']);
});

test('disabling the plugin removes every mark it made', async () => {
  const body = setBody('<p><a href="https://elsewhere.example/a">away</a></p>');

  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [externalLinksPlugin],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  await host.start();
  shared.update({
    body,
    source: '',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });
  assert.equal(body.querySelectorAll('[data-mdv-external]').length, 1);

  await host.setEnabled('external-links', false);

  assert.equal(
    body.querySelectorAll('[data-mdv-external]').length,
    0,
    'disabling the plugin left its attributes on the document',
  );
});

test('toggling repeatedly neither duplicates nor strands marks', async () => {
  const body = setBody('<p><a href="https://elsewhere.example/a">away</a></p>');

  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [externalLinksPlugin],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  await host.start();
  shared.update({
    body,
    source: '',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });

  for (let i = 0; i < 4; i += 1) {
    await host.setEnabled('external-links', false);
    await host.setEnabled('external-links', true);
  }

  assert.equal(body.querySelectorAll('[data-mdv-external]').length, 1);
});

test('a disabled plugin does not touch the document at all', async () => {
  const body = setBody('<p><a href="https://elsewhere.example/a">away</a></p>');

  const storage = memoryStorage();
  await storage.write({
    version: 1,
    global: {},
    plugins: { 'external-links': { enabled: false } },
  });

  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [externalLinksPlugin],
    storage,
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  await host.start();
  shared.update({
    body,
    source: '',
    html: '',
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });

  assert.equal(body.querySelectorAll('[data-mdv-external]').length, 0);
});
