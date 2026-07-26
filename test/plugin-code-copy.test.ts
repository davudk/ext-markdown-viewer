/**
 * Copy buttons, through the real host.
 *
 * The claim this asserts is the one the whole architecture rests on: the pass
 * wraps a code block, and disabling it puts the block back exactly where it was.
 * `Document.tsx` never had to answer that question — its pass was permanent and
 * the only way to undo it was to re-render the document — so the reversibility
 * is new even though the behaviour is not.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let createCodeCopyPlugin: typeof import('../plugins/code-copy/plugin.ts').createCodeCopyPlugin;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<div id="mdv-root"><main class="mdv-body"></main></div>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    'window',
    'document',
    // `navigator` is deliberately not installed: it is a getter on node's own
    // globalThis and cannot be assigned. Node supplies one without a
    // `clipboard`, which sends the copy down the legacy path — the same path a
    // file:// document takes, and the one worth exercising.
    'Node',
    'HTMLElement',
    'HTMLAnchorElement',
    'HTMLPreElement',
    'Element',
    'MouseEvent',
  ]) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  // No rAF under the bare runner, so SharedDocument runs passes inline — which
  // is what makes the assertions below synchronous.
  ({ createCodeCopyPlugin } = await import('../plugins/code-copy/plugin.ts'));
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

const BODY = `
  <p id="before">prose</p>
  <pre><code class="language-js">const x = 1;</code></pre>
  <p id="after">more prose</p>
`;

function setBody(html: string) {
  const body = dom.window.document.querySelector('main.mdv-body')!;
  body.innerHTML = html;
  return body as unknown as HTMLElement;
}

let host: PluginHost;
let shared: SharedDocument;
let body: HTMLElement;

function publish(isRaw = false) {
  shared.update({ body, source: '', html: '', headings: [], url: '', isRaw });
}

beforeEach(async () => {
  body = setBody(BODY);
  shared = new SharedDocument();
  host = new PluginHost({
    plugins: [createCodeCopyPlugin()],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
});

test('every code block is wrapped, with the language in the button label', () => {
  publish();

  const wrappers = body.querySelectorAll('.mdv-code');
  assert.equal(wrappers.length, 1);

  const wrapper = wrappers[0];
  // Button first in source order, so it is announced and reached before the
  // block it applies to.
  assert.equal(wrapper.firstElementChild?.className, 'mdv-copy');
  assert.equal(
    wrapper.firstElementChild?.getAttribute('aria-label'),
    'Copy js code',
    'the language was not carried into the label',
  );
  assert.equal(wrapper.querySelector('pre')?.textContent, 'const x = 1;');
});

test('an unhighlighted block gets the generic label', () => {
  body = setBody('<pre><code>plain</code></pre>');
  publish();

  assert.equal(
    body.querySelector('.mdv-copy')?.getAttribute('aria-label'),
    'Copy code',
  );
});

test('disabling puts the block back exactly where it stood', async () => {
  publish();
  assert.equal(body.querySelectorAll('.mdv-code').length, 1);

  await host.setEnabled('code-copy', false);

  assert.equal(body.querySelectorAll('.mdv-code').length, 0, 'a wrapper survived');
  assert.equal(body.querySelectorAll('.mdv-copy').length, 0, 'a button survived');
  assert.equal(body.querySelectorAll('pre').length, 1, 'the code block went with it');

  // Position, not merely presence: an unwrap that appended the block to the end
  // of the body would pass a existence check and reorder the document.
  assert.deepEqual(
    [...body.children].map((child) => child.tagName.toLowerCase()),
    ['p', 'pre', 'p'],
  );
  assert.equal(body.children[1].previousElementSibling?.id, 'before');
});

test('toggling repeatedly neither duplicates a wrapper nor strands one', async () => {
  publish();

  for (let round = 0; round < 4; round += 1) {
    await host.setEnabled('code-copy', false);
    await host.setEnabled('code-copy', true);
  }

  assert.equal(body.querySelectorAll('.mdv-code').length, 1);
  assert.equal(body.querySelectorAll('.mdv-copy').length, 1);
  assert.equal(body.querySelectorAll('pre').length, 1);
  // Ends enabled, so the wrapper is in place — and still in the block's
  // position, which is the failure mode a naive unwrap-and-reattach produces on
  // the third round rather than the first.
  assert.deepEqual(
    [...body.children].map((child) => child.tagName.toLowerCase()),
    ['p', 'div', 'p'],
  );
  assert.equal(body.children[1].className, 'mdv-code');

  await host.setEnabled('code-copy', false);
  assert.deepEqual(
    [...body.children].map((child) => child.tagName.toLowerCase()),
    ['p', 'pre', 'p'],
  );
});

test('a document re-render does not nest a second wrapper', () => {
  publish();
  publish();
  publish();

  assert.equal(body.querySelectorAll('.mdv-code').length, 1);
  assert.equal(body.querySelector('.mdv-code .mdv-code'), null);
});

test('the raw view is left alone — its one <pre> is the source', () => {
  publish(true);

  assert.equal(
    body.querySelectorAll('.mdv-code').length,
    0,
    'the raw source was offered a copy button',
  );
});

test('a click on the button reaches the clipboard path without throwing', () => {
  publish();

  const button = body.querySelector<HTMLElement>('.mdv-copy')!;
  // jsdom has neither `navigator.clipboard` nor `execCommand`, so this
  // exercises the fallback all the way to its failure — which is exactly the
  // path a file:// document takes, and it must not throw.
  assert.doesNotThrow(() => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
});

test('the delegated listener goes with the pass', async () => {
  publish();
  const button = body.querySelector<HTMLElement>('.mdv-copy')!;

  await host.setEnabled('code-copy', false);

  // The button is detached now, but the listener lived on the body — which is
  // still here. A click on the body must find nothing to do.
  assert.doesNotThrow(() => {
    body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(button.isConnected, false);
});
