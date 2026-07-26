/**
 * The image viewer, through the real host.
 *
 * Two halves, and the runner can reach both. The document side — claiming
 * images, releasing them, and the delegated activation — is plain DOM. The
 * overlay side is a `.tsx` the runner cannot mount, but what matters about it
 * is not its pixels: it is that opening goes through `ctx.ui.openOverlay`, that
 * the host closes it when the plugin is disabled, and that the session the
 * overlay reads is published as a capability rather than imported. All three are
 * observable from here.
 *
 * The overlay component is therefore a stand-in and everything else is real.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';

let createLightboxPlugin: typeof import('../plugins/lightbox/plugin.ts').createLightboxPlugin;
let dom: JSDOM;

const NOTHING = () => null;

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
    'HTMLImageElement',
    'Element',
    'MouseEvent',
    'KeyboardEvent',
  ]) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  ({ createLightboxPlugin } = await import('../plugins/lightbox/plugin.ts'));
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
  <p><img id="plain" src="one.png" alt="A diagram"></p>
  <p><img id="bare" src="two.png"></p>
  <p><a href="https://example.test/full.png"><img id="linked" src="three.png" alt="Linked"></a></p>
`;

let host: PluginHost;
let shared: SharedDocument;
let body: HTMLElement;

function publish(isRaw = false) {
  shared.update({ body, source: '', html: '', headings: [], url: '', isRaw });
}

const claimedIds = () =>
  [...body.querySelectorAll('[data-mdv-zoomable]')].map((image) => image.id);

function click(id: string) {
  body
    .querySelector(`#${id}`)!
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/**
 * Every test's host is torn down before the next one starts.
 *
 * Not tidiness: the tests share one `<main>`, and a host left running holds a
 * live delegated listener on it. That listener calls `preventDefault` on an
 * activation, and the next host's listener — which correctly ignores an already
 * handled click — would then see nothing to do. One page has one host, so this
 * is the runner catching up with reality rather than a bug being papered over.
 */
beforeEach(async () => {
  await host?.stop();

  body = dom.window.document.querySelector('main.mdv-body')! as unknown as HTMLElement;
  body.innerHTML = BODY;

  shared = new SharedDocument();
  host = new PluginHost({
    plugins: [createLightboxPlugin(NOTHING)],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
});

/* -------------------------------------------------------------------------- */
/* Claiming the document's images                                              */
/* -------------------------------------------------------------------------- */

test('every image is claimed except one that is already a link', () => {
  publish();

  // A linked image already has a job. Following the link is what its author
  // asked for, and a lightbox that swallowed that click would be a bug.
  assert.deepEqual(claimedIds(), ['plain', 'bare']);

  const image = body.querySelector('#plain')!;
  assert.equal(image.getAttribute('role'), 'button');
  assert.equal(image.getAttribute('tabindex'), '0');
  assert.equal(image.getAttribute('aria-label'), 'A diagram — view full size');
  assert.equal(
    body.querySelector('#bare')?.getAttribute('aria-label'),
    'View image full size',
    'an image with no alt was left unnamed',
  );
});

test('disabling releases every attribute it wrote', async () => {
  publish();
  assert.equal(claimedIds().length, 2);

  await host.setEnabled('lightbox', false);

  assert.deepEqual(claimedIds(), []);
  for (const id of ['plain', 'bare']) {
    const image = body.querySelector(`#${id}`)!;
    assert.equal(image.hasAttribute('role'), false, `${id} kept its role`);
    assert.equal(image.hasAttribute('tabindex'), false, `${id} kept its tabindex`);
    assert.equal(image.hasAttribute('aria-label'), false, `${id} kept its label`);
  }
});

test('toggling repeatedly claims each image exactly once', async () => {
  publish();

  for (let round = 0; round < 4; round += 1) {
    await host.setEnabled('lightbox', false);
    await host.setEnabled('lightbox', true);
  }

  assert.deepEqual(claimedIds(), ['plain', 'bare']);
});

test('the raw view is left alone', () => {
  publish(true);
  assert.deepEqual(claimedIds(), []);
});

/* -------------------------------------------------------------------------- */
/* Opening, through the host's overlay manager                                 */
/* -------------------------------------------------------------------------- */

test('a click opens one managed overlay, not a portal of its own', () => {
  publish();
  assert.equal(host.overlays.store.get().length, 0);

  click('plain');

  const open = host.overlays.store.get();
  assert.equal(open.length, 1);
  assert.equal(open[0].pluginId, 'lightbox');
  assert.equal(open[0].id, 'lightbox');
  // The host names the dialog for assistive technology; the plugin no longer
  // writes `role`, `aria-modal` or a z-index of its own.
  assert.equal(open[0].label, 'Image viewer');
});

test('the click is prevented, and a click on a linked image is not', () => {
  publish();

  const opened = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  body.querySelector('#plain')!.dispatchEvent(opened);
  assert.equal(opened.defaultPrevented, true);

  const followed = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  body.querySelector('#linked')!.dispatchEvent(followed);
  assert.equal(followed.defaultPrevented, false, 'the link was swallowed');
});

test('a modified click belongs to the browser', () => {
  publish();

  body.querySelector('#plain')!.dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
  );

  assert.equal(host.overlays.store.get().length, 0);
});

test('Enter and Space activate a claimed image, since it says it is a button', () => {
  publish();

  body.querySelector('#plain')!.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );

  assert.equal(host.overlays.store.get().length, 1);
});

test('the session the overlay reads is a capability, and it says which slide', () => {
  publish();
  click('bare');

  // Published rather than imported: the overlay is a contribution with no props
  // but `close`, and this is the route back to what `setup` opened.
  const session = host.capabilities.use('lightbox')!;
  const snapshot = session.store.get()!;

  assert.deepEqual(
    snapshot.slides.map((slide) => slide.image.id),
    ['plain', 'bare'],
    'the gallery is every claimed image, in document order',
  );
  assert.equal(snapshot.index, 1);

  // Wraps rather than stops: the counter says where you are, so a ring is safe.
  session.step(1);
  assert.equal(session.store.get()!.index, 0);
  session.step(-1);
  assert.equal(session.store.get()!.index, 1);
});

test('a second click does not stack a second overlay', () => {
  publish();
  click('plain');
  click('plain');

  assert.equal(host.overlays.store.get().length, 1);
});

test('disabling the plugin closes the overlay and clears the session', async () => {
  publish();
  click('plain');
  assert.equal(host.overlays.store.get().length, 1);

  await host.setEnabled('lightbox', false);

  assert.equal(host.overlays.store.get().length, 0, 'the overlay outlived its plugin');
  assert.equal(host.capabilities.use('lightbox'), undefined);
});

test('switching to the raw view takes the overlay down with it', () => {
  publish();
  click('plain');
  assert.equal(host.overlays.store.get().length, 1);

  publish(true);

  // An overlay left over a document that is no longer there is worse than none.
  assert.equal(host.overlays.store.get().length, 0);
  assert.equal(host.capabilities.use('lightbox')!.store.get(), null);
});

test('a live reload that drops the image closes the overlay', () => {
  publish();
  click('plain');

  // A new body: the slide on screen is now a node in no document, and there is
  // nothing left to return focus to.
  body.innerHTML = '<p>the document changed entirely</p>';
  publish();

  assert.equal(host.overlays.store.get().length, 0);
});

after(async () => {
  await host?.stop();
});
