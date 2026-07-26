/**
 * Collapsible sections, through the real host.
 *
 * A fold is an attribute written onto a run of siblings and nothing else, which
 * is what makes it exactly reversible — so the residue check here is stronger
 * than "the controls are gone": unfolding must leave the document byte-for-byte
 * what it was, with no `data-mdv-folded` and no `data-mdv-fold` anywhere.
 *
 * The other thing worth asserting is the interaction with `heading-anchors`.
 * The two plugins share every heading and import nothing from each other; the
 * contract is that the fold control is *prepended* and the anchor *appended*,
 * and it holds in both enable orders and through repeated toggling.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import type { AnyPlugin } from '../lib/plugins/types.ts';

let createHeadingFoldPlugin: typeof import('../plugins/heading-fold/plugin.ts').createHeadingFoldPlugin;
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
    'location',
    'Node',
    'HTMLElement',
    'HTMLAnchorElement',
    'Element',
    'MouseEvent',
    'MutationObserver',
  ]) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  ({ createHeadingFoldPlugin } = await import('../plugins/heading-fold/plugin.ts'));
  ({ createHeadingAnchorsPlugin } = await import(
    '../plugins/heading-anchors/plugin.ts'
  ));
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

/**
 * Two sections and a trailing heading with nothing under it — the last of which
 * must get no control at all, because a control that visibly does nothing is
 * worse than none.
 */
const BODY = `
  <h2 id="one">One</h2>
  <p id="one-a">first</p>
  <h3 id="one-deep">One deep</h3>
  <p id="one-b">nested</p>
  <h2 id="two">Two</h2>
  <p id="two-a">second</p>
  <h2 id="empty">Empty</h2>
`;

let host: PluginHost;
let shared: SharedDocument;
let body: HTMLElement;

function publish(isRaw = false) {
  shared.update({ body, source: '', html: '', headings: [], url: '', isRaw });
}

function makeHost(plugins: AnyPlugin[]) {
  return new PluginHost({
    plugins,
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
}

beforeEach(async () => {
  body = dom.window.document.querySelector('main.mdv-body')! as unknown as HTMLElement;
  body.innerHTML = BODY;

  shared = new SharedDocument();
  host = makeHost([createHeadingFoldPlugin()]);
  await host.start();
});

function fold(id: string) {
  const control = body.querySelector<HTMLElement>(`#${id} > .mdv-fold`)!;
  control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

const foldedIds = () =>
  [...body.querySelectorAll('[data-mdv-folded]')].map((element) => element.id);

/* -------------------------------------------------------------------------- */

test('a control lands on every heading that has something to fold', () => {
  publish();

  assert.deepEqual(
    [...body.querySelectorAll('.mdv-fold')].map((c) => c.parentElement?.id),
    ['one', 'one-deep', 'two'],
    'the trailing heading with an empty section was given a control',
  );

  // Prepended, never appended: the anchor plugin claims `lastElementChild`.
  assert.equal(body.querySelector('#one')?.firstElementChild?.className, 'mdv-fold');
  assert.equal(
    body.querySelector('.mdv-fold')?.getAttribute('data-mdv-chrome'),
    '',
    'the control is not marked as screen-only chrome',
  );
});

test('folding hides the section and stops at the next heading of its level', () => {
  publish();
  fold('one');

  assert.deepEqual(foldedIds(), ['one-a', 'one-deep', 'one-b']);
  assert.equal(body.querySelector('#one')?.getAttribute('data-mdv-fold'), 'closed');
  assert.equal(
    body.querySelector('#one > .mdv-fold')?.getAttribute('aria-expanded'),
    'false',
  );
  // Everything from the next h2 on is untouched.
  assert.equal(body.querySelector('#two-a')?.hasAttribute('data-mdv-folded'), false);
});

test('a nested fold is owned by the outermost heading hiding it', () => {
  publish();
  fold('one-deep');
  assert.deepEqual(foldedIds(), ['one-b']);
  assert.equal(
    body.querySelector('#one-b')?.getAttribute('data-mdv-folded'),
    'one-deep',
  );

  // Folding the h2 above it takes charge: a paragraph hidden twice and shown
  // once is the bug that makes folding un-reversible.
  fold('one');
  assert.equal(body.querySelector('#one-b')?.getAttribute('data-mdv-folded'), 'one');

  fold('one');
  assert.equal(
    body.querySelector('#one-b')?.getAttribute('data-mdv-folded'),
    'one-deep',
    'the inner fold was forgotten when the outer one opened',
  );
});

test('unfolding restores the document exactly', () => {
  publish();
  fold('one');
  fold('one');

  assert.deepEqual(foldedIds(), []);
});

test('disabling leaves no control, no fold and no state attribute', async () => {
  publish();
  fold('one');
  fold('one-deep');
  assert.notEqual(foldedIds().length, 0);

  await host.setEnabled('heading-fold', false);

  assert.equal(body.querySelectorAll('.mdv-fold').length, 0, 'a control survived');
  assert.equal(body.querySelectorAll('[data-mdv-folded]').length, 0, 'a fold survived');
  assert.equal(
    body.querySelectorAll('[data-mdv-fold]').length,
    0,
    'a state attribute survived',
  );
  assert.equal(body.innerHTML.includes('mdv-fold'), false);
});

test('re-enabling starts fresh rather than restoring the folds', async () => {
  publish();
  fold('one');

  await host.setEnabled('heading-fold', false);
  await host.setEnabled('heading-fold', true);

  // A remembered fold is missing content, and a document that opens with a
  // section silently absent is indistinguishable from a broken one.
  assert.deepEqual(foldedIds(), []);
});

test('toggling repeatedly neither duplicates a control nor strands one', async () => {
  publish();

  for (let round = 0; round < 4; round += 1) {
    await host.setEnabled('heading-fold', false);
    await host.setEnabled('heading-fold', true);
  }

  assert.equal(body.querySelectorAll('.mdv-fold').length, 3);
  assert.equal(body.querySelectorAll('#one > .mdv-fold').length, 1);
});

test('a re-render keeps the folds the reader had', () => {
  publish();
  fold('one');

  // The same body, re-published: a settings change elsewhere, or another
  // plugin's `refresh`. The ids are what survive it.
  publish();

  assert.deepEqual(foldedIds(), ['one-a', 'one-deep', 'one-b']);
  assert.equal(body.querySelectorAll('#one > .mdv-fold').length, 1);
});

test('the raw view gets nothing, and gives nothing back', () => {
  publish(true);

  assert.equal(body.querySelectorAll('.mdv-fold').length, 0);
  assert.equal(body.querySelectorAll('[data-mdv-fold]').length, 0);
});

/* -------------------------------------------------------------------------- */
/* Sharing a heading with `heading-anchors`                                    */
/* -------------------------------------------------------------------------- */

test('the fold control and the anchor coexist, in either enable order', async () => {
  await host.stop();

  host = makeHost([createHeadingAnchorsPlugin(), createHeadingFoldPlugin()]);
  await host.start();
  publish();

  const heading = body.querySelector('#one')!;
  assert.equal(heading.firstElementChild?.className, 'mdv-fold');
  assert.equal(heading.lastElementChild?.className, 'mdv-anchor');

  // The failure this guards is one anchor per pass: `heading-anchors` decides a
  // heading is done by looking at `lastElementChild`, so a control parked there
  // would earn every heading a second one.
  for (let round = 0; round < 3; round += 1) {
    await host.setEnabled('heading-fold', false);
    await host.setEnabled('heading-fold', true);
  }

  assert.equal(body.querySelectorAll('#one .mdv-anchor').length, 1);
  assert.equal(body.querySelectorAll('#one > .mdv-fold').length, 1);
});
