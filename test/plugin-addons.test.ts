/**
 * The add-on request, which is the half of lazy loading that was missing.
 *
 * Math and mermaid both render in two stages: a plugin marks the document up,
 * and an injected add-on turns those marks into output. The marking worked and
 * nothing ever asked for the add-on, so every equation stayed as its own TeX
 * and every diagram as its own source — with no error anywhere, because both
 * degradations are the designed fallback.
 *
 * What is asserted here is exactly the seam that was absent: a document with
 * the syntax asks once, a document without it never asks at all, and asking
 * twice for the same add-on sends one message. The last one is not pedantry —
 * the pass re-runs on every render, and mermaid is 3.3MB.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { MATH_PLACEHOLDER_CLASS, MERMAID_LANGUAGE } from '../lib/config.ts';
import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

import type { AnyPlugin } from '../lib/plugins/types.ts';

let resetRequestedAddons: typeof import('../lib/addons.ts').resetRequestedAddons;
let markdownMathPlugin: AnyPlugin;
let markdownMermaidPlugin: AnyPlugin;

/** Every `INJECT_ADDON` message the plugins sent, in order. */
let sent: string[] = [];
/** What the fake service worker replies. */
let reply: { ok: boolean; error?: string } = { ok: true };

before(async () => {
  const dom = new JSDOM('<div id="mdv-root"><main class="mdv-body"></main></div>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  // `lib/messages.ts` calls `chrome.runtime.sendMessage` directly, so the stub
  // goes in at that boundary rather than behind another indirection.
  globals.chrome = {
    runtime: {
      sendMessage: async (message: { type: string; addon: string }) => {
        if (message.type === 'INJECT_ADDON') sent.push(message.addon);
        return reply;
      },
    },
  };

  ({ resetRequestedAddons } = await import('../lib/addons.ts'));
  ({ markdownMathPlugin } = await import('../plugins/markdown-math/index.ts'));
  ({ markdownMermaidPlugin } = await import('../plugins/markdown-mermaid/index.ts'));
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

beforeEach(() => {
  sent = [];
  reply = { ok: true };
  resetRequestedAddons();
});

/** Runs one plugin against a body, and returns the host so it can be stopped. */
async function run(plugin: AnyPlugin, html: string) {
  const body = document.querySelector<HTMLElement>('main.mdv-body')!;
  body.innerHTML = html;

  const documentHandle = new SharedDocument();
  const host = new PluginHost({
    plugins: [plugin],
    storage: memoryStorage(),
    document: documentHandle,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
  documentHandle.update({
    body,
    source: '',
    html,
    headings: [],
    url: 'https://example.test/docs/a.md',
    isRaw: false,
  });
  // No rAF under the bare runner, so the pass has already run inline; the await
  // is for the request itself, which is a promise the pass does not hold.
  await Promise.resolve();
  await Promise.resolve();
  return { host, documentHandle, body };
}

const MATH = `<span class="${MATH_PLACEHOLDER_CLASS}">x^2</span>`;
const MERMAID = `<pre><code class="hljs language-${MERMAID_LANGUAGE}">graph TD</code></pre>`;

test('a document with math asks for the KaTeX add-on', async () => {
  const { host } = await run(markdownMathPlugin, `<p>${MATH}</p>`);
  assert.deepEqual(sent, ['katex']);
  await host.stop();
});

test('a document with a diagram asks for the mermaid add-on', async () => {
  const { host } = await run(markdownMermaidPlugin, MERMAID);
  assert.deepEqual(sent, ['mermaid']);
  await host.stop();
});

test('a plain document asks for neither', async () => {
  // The whole point of the split: a README with no equations and no diagrams
  // must not pull 3.6MB across the two of them.
  const math = await run(markdownMathPlugin, '<p>just prose, and a $ sign</p>');
  await math.host.stop();
  const mermaid = await run(markdownMermaidPlugin, '<pre><code class="language-js">1</code></pre>');
  await mermaid.host.stop();

  assert.deepEqual(sent, []);
});

test('re-running the pass does not inject twice', async () => {
  const { host, documentHandle } = await run(markdownMermaidPlugin, MERMAID);
  documentHandle.refresh();
  documentHandle.refresh();
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(sent, ['mermaid'], 'the add-on was injected more than once');
  await host.stop();
});

test('a refused injection is retried, not cached as failure', async () => {
  // The likeliest cause is a sleeping service worker, which will be awake next
  // time — so a failure must not be remembered as "already asked".
  reply = { ok: false, error: 'no sender tab' };
  const first = await run(markdownMathPlugin, `<p>${MATH}</p>`);
  await first.host.stop();
  assert.deepEqual(sent, ['katex']);

  reply = { ok: true };
  const second = await run(markdownMathPlugin, `<p>${MATH}</p>`);
  await second.host.stop();
  assert.deepEqual(sent, ['katex', 'katex']);
});
