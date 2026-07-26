/**
 * Live reload through the real host, with a fake clock and a fake `fetch`.
 *
 * This is the plugin the teardown contract was written for. A poll reschedules
 * itself from inside its own callback, so "disable" has to reach a timer that
 * does not exist yet — and a stranded one keeps requesting a server forever,
 * with no feature on screen to explain it. The assertion that matters is the
 * last one: after disabling, the clock runs on and the request count does not.
 *
 * The request itself is asserted too, because the guarantee is not "it polls"
 * but "it polls *this* address, with no body and no redirect".
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let liveReloadPlugin: typeof import('../plugins/live-reload/index.ts').liveReloadPlugin;
let dom: JSDOM;

const URL_A = 'https://example.test/docs/a.md';

let requests: Array<{ url: string; init: RequestInit }> = [];
let served = '# One';

before(async () => {
  dom = new JSDOM('<main class="mdv-body"></main>', { url: URL_A });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'location']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  globals.fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      type: 'basic',
      headers: { get: () => null },
      async text() {
        return served;
      },
    };
  };

  ({ liveReloadPlugin } = await import('../plugins/live-reload/index.ts'));
});

beforeEach(() => {
  requests = [];
  served = '# One';
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

/** Lets the fetch promise chain settle between ticks of the fake clock. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function harness(onReload: (source: string) => void) {
  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: [liveReloadPlugin],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  host.capabilities.provide('document.reload', onReload);
  return { shared, host };
}

function publish(shared: SharedDocument, url = URL_A) {
  shared.update({
    body: dom.window.document.querySelector('main.mdv-body') as unknown as HTMLElement,
    source: '# One',
    html: '',
    headings: [],
    url,
    isRaw: false,
  });
}

test('it polls the document, reports an edit, and stops dead when disabled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const reloads: string[] = [];
  const { shared, host } = harness((source) => reloads.push(source));

  // Off by default: the one feature that talks to a server.
  assert.equal(liveReloadPlugin.enabledByDefault, false);

  await host.start();
  await host.setEnabled('live-reload', true);
  publish(shared);

  t.mock.timers.tick(3_000);
  await settle();

  assert.equal(requests.length, 1, 'the first poll did not happen');
  assert.equal(requests[0].url, URL_A, 'polled an address that is not the document');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.credentials, 'same-origin');
  assert.equal((requests[0].init as { body?: unknown }).body, undefined);

  served = '# Two';
  t.mock.timers.tick(3_000);
  await settle();
  assert.deepEqual(reloads, ['# Two'], 'an edit was not reported');

  const before = requests.length;
  await host.setEnabled('live-reload', false);

  // A minute of clock with nothing on screen asking for it.
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(requests.length, before, 'a poll timer survived the teardown');
});

test('toggling repeatedly leaves exactly one poller, never two', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { shared, host } = harness(() => {});
  await host.start();

  for (let i = 0; i < 3; i += 1) {
    await host.setEnabled('live-reload', true);
    publish(shared);
    await host.setEnabled('live-reload', false);
  }

  await host.setEnabled('live-reload', true);
  publish(shared);

  requests = [];
  t.mock.timers.tick(3_000);
  await settle();
  assert.equal(requests.length, 1, 'each toggle left another poller running');

  await host.stop();
  requests = [];
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(requests.length, 0);
});

test('a document with no fetchable address is never polled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const { shared, host } = harness(() => {});
  await host.start();
  await host.setEnabled('live-reload', true);

  // What the files plugin hands over: read through a directory handle, with no
  // URL the network could resolve. It must not fall back to the page's own.
  publish(shared, 'mdv-folder:/notes/b.md');

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(requests.length, 0, 'polled a document that has no address');

  await host.stop();
});
