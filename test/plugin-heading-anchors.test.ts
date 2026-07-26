/**
 * Heading anchors, through the real host.
 *
 * Two things beyond "it adds a link". The anchor must be the heading's *last*
 * element child, because `heading-fold` prepends its control and reads that
 * position to decide whether the anchor is already there — the two plugins share
 * a heading and no import, so the contract between them is the DOM. And the
 * teardown removes the anchors this pass created rather than everything matching
 * `.mdv-anchor`, which is what keeps it honest if a document ever ships one.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let createHeadingAnchorsPlugin: typeof import('../plugins/heading-anchors/plugin.ts').createHeadingAnchorsPlugin;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<div id="mdv-root"><main class="mdv-body"></main></div>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    'window',
    'document',
    'Node',
    'HTMLElement',
    'HTMLAnchorElement',
    'Element',
    'MouseEvent',
  ]) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  ({ createHeadingAnchorsPlugin } = await import('../plugins/heading-anchors/plugin.ts'));
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
  <h1 id="title">Title</h1>
  <h2 id="one">One</h2>
  <h4 id="deep">Deep</h4>
  <h5 id="deeper">Deeper</h5>
  <h2>No id at all</h2>
  <p>prose</p>
`;

let host: PluginHost;
let shared: SharedDocument;
let body: HTMLElement;

function publish(isRaw = false) {
  shared.update({ body, source: '', html: '', headings: [], url: '', isRaw });
}

beforeEach(async () => {
  body = dom.window.document.querySelector('main.mdv-body')! as unknown as HTMLElement;
  body.innerHTML = BODY;

  shared = new SharedDocument();
  host = new PluginHost({
    plugins: [createHeadingAnchorsPlugin()],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
});

test('every h1–h4 with an id gets an anchor, and nothing else does', () => {
  publish();

  assert.deepEqual(
    [...body.querySelectorAll('a.mdv-anchor')].map((a) => a.getAttribute('href')),
    ['#title', '#one', '#deep'],
    'h5, and a heading with no id, are not destinations',
  );
});

test('the anchor is the last element child, which heading-fold depends on', () => {
  publish();

  const heading = body.querySelector('#title')!;
  assert.equal(heading.lastElementChild?.className, 'mdv-anchor');
});

test('disabling removes every anchor it added', async () => {
  publish();
  assert.equal(body.querySelectorAll('.mdv-anchor').length, 3);

  await host.setEnabled('heading-anchors', false);

  assert.equal(body.querySelectorAll('.mdv-anchor').length, 0);
  // The headings themselves are untouched: an anchor is appended, so removing
  // it must leave the heading's own text exactly as it was.
  assert.equal(body.querySelector('#title')?.textContent, 'Title');
});

test('toggling repeatedly gives each heading exactly one anchor', async () => {
  publish();

  for (let round = 0; round < 4; round += 1) {
    await host.setEnabled('heading-anchors', false);
    await host.setEnabled('heading-anchors', true);
  }

  assert.equal(body.querySelectorAll('.mdv-anchor').length, 3);
  assert.equal(body.querySelectorAll('#title .mdv-anchor').length, 1);
});

test('a re-render of the same document does not stack anchors', () => {
  publish();
  publish();
  publish();

  assert.equal(body.querySelectorAll('.mdv-anchor').length, 3);
});

test('the raw view gets none — it has no headings to point at', () => {
  publish(true);
  assert.equal(body.querySelectorAll('.mdv-anchor').length, 0);
});

test('clicking an anchor does not prevent the link, and does not throw', () => {
  publish();

  const anchor = body.querySelector<HTMLElement>('.mdv-anchor')!;
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  body.dispatchEvent(event);

  assert.doesNotThrow(() => anchor.dispatchEvent(event));
  assert.equal(
    event.defaultPrevented,
    false,
    'the anchor stopped behaving like a link',
  );
});
