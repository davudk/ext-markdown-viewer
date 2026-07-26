/**
 * Link previews, through the real host.
 *
 * Two halves, and the runner reaches both. The decisions — which links qualify,
 * what a preview is made of, where it goes when the browser will not decide —
 * are pure and asserted directly. The behaviour is the delegated listeners, the
 * delay, and the teardown, which need a body and a clock but not a layout: the
 * clock is injected, so "nothing happened yet" and "this timer can no longer
 * fire" are ordinary assertions rather than a race.
 *
 * jsdom implements no Popover API, which is not a gap here but a case: it is
 * the fallback path, and it is the path that has to work when Chrome's anchor
 * positioning is missing. The tests run against it for exactly that reason.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import { Store } from '../lib/plugins/registry.ts';
import { NO_FOLDER, type FolderBrowserHandle } from '../plugins/files/types.ts';

let createHoverPreviewsPlugin: typeof import('../plugins/hover-previews/plugin.ts').createHoverPreviewsPlugin;
let detectSurface: typeof import('../plugins/hover-previews/plugin.ts').detectSurface;
let preview: typeof import('../plugins/hover-previews/preview.ts');
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
    'KeyboardEvent',
    'FocusEvent',
  ]) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  ({ createHoverPreviewsPlugin, detectSurface } = await import(
    '../plugins/hover-previews/plugin.ts'
  ));
  preview = await import('../plugins/hover-previews/preview.ts');
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
 * The clock, under the test's control.
 *
 * `run()` is the only way anything scheduled ever fires, which is what makes
 * "the preview does not appear before the delay" assertable, and `cleared`
 * records the cancellations the teardown assertion is about.
 */
function manualTimers() {
  const scheduled = new Map<number, { run: () => void; ms: number }>();
  const cleared: number[] = [];
  let next = 1;

  return {
    timers: {
      set(run: () => void, ms: number) {
        const handle = next++;
        scheduled.set(handle, { run, ms });
        return handle;
      },
      clear(handle: number) {
        cleared.push(handle);
        scheduled.delete(handle);
      },
    },
    cleared,
    get pending() {
      return [...scheduled.values()];
    },
    /** Fires everything outstanding, as the real clock would. */
    run() {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const timer of due) timer.run();
    },
  };
}

const BODY = `
  <h2 id="install">Install</h2>
  <p id="p1">Run the installer.</p>
  <p id="p2">Then restart.</p>
  <p id="p3">Then read on.</p>
  <h2 id="usage">Usage</h2>
  <p>
    A footnote<a id="fnref1" class="footnote-ref" href="#fn1">[1]</a>,
    an <a id="anchor" href="#install">anchor</a>,
    a <a id="missing" href="#nowhere">dead anchor</a>,
    a <a id="file" href="guide.md">file</a>,
    a <a id="wiki" class="mdv-wikilink" href="Some%20Page.md">wikilink</a>,
    an <a id="ext" href="https://elsewhere.test/x">external</a>,
    a <a id="samehost" href="https://example.test/docs/b.md">same-host absolute</a>,
    a <a id="mail" href="mailto:someone@example.test">mail</a>,
    an <a id="image" href="picture.png">image</a>.
  </p>
  <section class="footnotes"><ol><li id="fn1"><p>The note itself.</p></li></ol></section>
`;

function setBody(html: string) {
  const body = dom.window.document.querySelector('main.mdv-body')!;
  body.innerHTML = html;
  return body as unknown as HTMLElement;
}

let host: PluginHost;
let shared: SharedDocument;
let body: HTMLElement;
let clock: ReturnType<typeof manualTimers>;
/** Requests the folder browser served, so "never fetched" can be asserted. */
let reads: string[];

const panels = () =>
  [...dom.window.document.body.querySelectorAll('.mdv-preview')] as HTMLElement[];

function link(id: string): HTMLAnchorElement {
  return body.querySelector(`#${id}`) as unknown as HTMLAnchorElement;
}

function hover(id: string) {
  link(id).dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
}

function leave(id: string) {
  link(id).dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true }));
}

function publish(url = 'https://example.test/docs/a.md', isRaw = false) {
  shared.update({ body, source: '', html: '', headings: [], url, isRaw });
}

/**
 * A folder browser with one file in it.
 *
 * Published straight onto the host's capability store the way the shell does,
 * because the Files plugin is not loaded here — this plugin reads the
 * capability, and never the plugin that provides it.
 */
function provideFolder(files: string[], contents: Record<string, string>) {
  const handle: FolderBrowserHandle = {
    ...NO_FOLDER,
    supported: true,
    rootName: 'Notes',
    files: files.map((path) => ({ id: path, name: path, detail: '' })),
    read: async (id) => {
      reads.push(id);
      const text = contents[id];
      if (text === undefined) throw new Error('gone');
      return text;
    },
  };
  host.capabilities.provide('files.browser', new Store(handle));
}

beforeEach(async () => {
  // Any panel a previous test's host left behind would be residue this one
  // would then blame on itself; nothing should ever be here.
  for (const panel of panels()) panel.remove();

  body = setBody(BODY);
  reads = [];
  clock = manualTimers();
  shared = new SharedDocument();
  host = new PluginHost({
    plugins: [createHoverPreviewsPlugin(clock.timers)],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
});

/* -------------------------------------------------------------------------- */
/* What is previewable — and what is refused                                   */
/* -------------------------------------------------------------------------- */

test('only the four kinds are claimed', () => {
  publish();

  const claimed = Object.fromEntries(
    [...body.querySelectorAll('[data-mdv-preview]')].map((element) => [
      element.id,
      element.getAttribute('data-mdv-preview'),
    ]),
  );

  assert.deepEqual(claimed, {
    fnref1: 'fragment',
    anchor: 'fragment',
    missing: 'fragment',
    file: 'file',
    wiki: 'file',
  });
});

test('an http(s) link is never previewed, and never fetched', () => {
  publish();
  provideFolder(['guide.md'], { 'guide.md': '# Guide' });

  for (const id of ['ext', 'samehost', 'mail', 'image']) {
    assert.equal(
      link(id).hasAttribute('data-mdv-preview'),
      false,
      `${id} was claimed, and previewing it would mean fetching it`,
    );

    hover(id);
    clock.run();
    assert.equal(panels().length, 0, `${id} produced a preview`);
  }

  // The one call that could reach outside this page is the folder read, and
  // nothing above is a file in the folder. Nothing else in this plugin can
  // make a request at all: there is no fetch, no XHR and no <img>.
  assert.deepEqual(reads, []);
});

test('previewKind refuses every absolute address, whatever the host', () => {
  const here = 'https://example.test/docs/a.md';

  assert.equal(preview.previewKind('#fn1', here), 'fragment');
  assert.equal(preview.previewKind('guide.md', here), 'file');
  assert.equal(preview.previewKind('../notes/b.markdown#top', here), 'file');
  assert.equal(preview.previewKind('Some%20Page.md', here), 'file');

  assert.equal(preview.previewKind('https://elsewhere.test/x.md', here), null);
  // Same host is still a request, so it is still refused.
  assert.equal(preview.previewKind('https://example.test/docs/b.md', here), null);
  assert.equal(preview.previewKind('http://example.test/docs/b.md', here), null);
  assert.equal(preview.previewKind('//example.test/b.md', here), null);
  assert.equal(preview.previewKind('mailto:a@b.test', here), null);
  assert.equal(preview.previewKind('javascript:alert(1)', here), null);
  assert.equal(preview.previewKind('picture.png', here), null);
  assert.equal(preview.previewKind('', here), null);
  assert.equal(preview.previewKind('#', here), null);

  // A document opened through a directory handle has an opaque-path URL that
  // nothing resolves against; its relative links still qualify.
  assert.equal(preview.previewKind('b.md', 'mdv-folder:Notes/a.md'), 'file');
  assert.equal(preview.previewKind('https://x.test/b.md', 'mdv-folder:Notes/a.md'), null);
});

/* -------------------------------------------------------------------------- */
/* Showing                                                                     */
/* -------------------------------------------------------------------------- */

test('an anchor previews its section plus roughly two blocks', () => {
  publish();

  hover('anchor');
  assert.equal(panels().length, 0, 'the preview appeared before the delay elapsed');

  clock.run();

  const [panel] = panels();
  assert.ok(panel, 'no preview appeared');
  assert.equal(panel.getAttribute('data-mdv-chrome'), '');
  assert.equal(panel.getAttribute('role'), 'tooltip');
  assert.match(panel.textContent!, /Install/);
  assert.match(panel.textContent!, /Run the installer/);
  assert.match(panel.textContent!, /Then restart/);
  // Capped, and stopped before the next section either way.
  assert.doesNotMatch(panel.textContent!, /Then read on/);
  assert.doesNotMatch(panel.textContent!, /Usage/);

  // The clone must not duplicate the ids of the live document.
  assert.equal(panel.querySelector('[id]'), null);
});

test('a footnote reference previews the note, alone', () => {
  publish();

  hover('fnref1');
  clock.run();

  assert.equal(panels()[0]?.textContent?.trim(), 'The note itself.');
});

test('an anchor with no target shows nothing at all', () => {
  publish();

  hover('missing');
  clock.run();

  assert.equal(panels().length, 0, 'an empty panel claims the target exists');
});

test('mouseout and Escape both dismiss', () => {
  publish();

  hover('anchor');
  clock.run();
  assert.equal(panels().length, 1);

  leave('anchor');
  assert.equal(panels().length, 0);

  hover('anchor');
  clock.run();
  assert.equal(panels().length, 1);

  dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assert.equal(panels().length, 0);
});

test('focus previews too, and the preview never takes focus', () => {
  publish();

  link('anchor').dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
  clock.run();

  const [panel] = panels();
  assert.ok(panel);
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.hasAttribute('tabindex'), false);
  assert.equal(panel.querySelector('a[href], button, [tabindex]'), null);
  assert.equal(dom.window.document.activeElement, dom.window.document.body);
});

test('the raw view has nothing to preview and dismisses what is up', () => {
  publish();
  hover('anchor');
  clock.run();
  assert.equal(panels().length, 1);

  publish('https://example.test/docs/a.md', true);
  assert.equal(panels().length, 0);
  assert.equal(body.querySelector('[data-mdv-preview]'), null);
});

/* -------------------------------------------------------------------------- */
/* Cross-file                                                                  */
/* -------------------------------------------------------------------------- */

test('a relative file link previews through the folder handle', async () => {
  publish('mdv-folder:Notes/docs/a.md');
  provideFolder(['docs/guide.md'], {
    'docs/guide.md': '---\ntitle: Guide\n---\n\nFirst paragraph.\n\nSecond paragraph.\n',
  });

  hover('file');
  clock.run();
  await Promise.resolve();
  await Promise.resolve();

  const [panel] = panels();
  assert.ok(panel, 'no cross-file preview appeared');
  assert.deepEqual(reads, ['docs/guide.md']);
  assert.match(panel.textContent!, /docs\/guide\.md/);
  assert.match(panel.textContent!, /First paragraph/);
  assert.doesNotMatch(panel.textContent!, /title: Guide/);
});

test('without a folder handle a file link is skipped silently', async () => {
  publish('https://example.test/docs/a.md');

  hover('file');
  clock.run();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(panels().length, 0);
  assert.deepEqual(reads, []);
});

/* -------------------------------------------------------------------------- */
/* The delay, and what must not outlive the plugin                             */
/* -------------------------------------------------------------------------- */

test('the delay is the configured one, and resting is what starts it', () => {
  publish();

  hover('anchor');
  assert.deepEqual(
    clock.pending.map((timer) => timer.ms),
    [300],
  );
  assert.equal(panels().length, 0);
});

test('a timer pending at teardown is cancelled, and cannot fire afterwards', async () => {
  publish();

  hover('anchor');
  const [scheduled] = clock.pending;
  assert.ok(scheduled, 'nothing was scheduled');

  await host.setEnabled('hover-previews', false);

  assert.equal(clock.pending.length, 0, 'the pending timer was left scheduled');
  assert.equal(clock.cleared.length > 0, true, 'clearTimeout was never called');

  // And the belt: a handle that somehow survived the cancellation still does
  // nothing, because the callback checks the generation it was started in.
  scheduled.run();
  assert.equal(panels().length, 0, 'a stranded timer produced a preview');
});

test('disabling leaves no residue, and re-enabling accumulates none', async () => {
  publish();

  hover('anchor');
  clock.run();
  assert.equal(panels().length, 1);

  await host.setEnabled('hover-previews', false);

  assert.equal(panels().length, 0, 'a panel outlived the plugin');
  assert.equal(body.querySelector('[data-mdv-preview]'), null, 'links stayed claimed');
  assert.equal(body.innerHTML.includes('anchor-name'), false);

  for (let round = 0; round < 3; round += 1) {
    await host.setEnabled('hover-previews', true);
    publish();

    hover('anchor');
    clock.run();
    assert.equal(panels().length, 1, `round ${round} produced ${panels().length} panels`);

    await host.setEnabled('hover-previews', false);
    assert.equal(panels().length, 0);
  }
});

/* -------------------------------------------------------------------------- */
/* The decisions the Popover API would otherwise hide                          */
/* -------------------------------------------------------------------------- */

test('jsdom has no Popover API, and the plugin does not pretend otherwise', () => {
  const surface = detectSurface(dom.window as unknown as Window);
  assert.deepEqual(surface, { popover: false, anchorPositioning: false });
});

test('the fallback flips above a link near the bottom, and never off-screen', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 400, height: 300 };

  const below = preview.decidePlacement(
    { left: 100, top: 100, width: 60, height: 20 },
    viewport,
    size,
  );
  assert.equal(below.side, 'below');
  assert.equal(below.top, 128);
  assert.equal(below.left, 100);

  const flipped = preview.decidePlacement(
    { left: 100, top: 700, width: 60, height: 20 },
    viewport,
    size,
  );
  assert.equal(flipped.side, 'above');
  assert.equal(flipped.top, 392);

  // Pulled back inside rather than clipped at the right edge.
  const edge = preview.decidePlacement(
    { left: 950, top: 100, width: 40, height: 20 },
    viewport,
    size,
  );
  assert.equal(edge.left, 592);

  // Taller than the space above and below: still starts on screen.
  const cramped = preview.decidePlacement(
    { left: 10, top: 30, width: 40, height: 20 },
    { width: 1000, height: 120 },
    size,
  );
  assert.ok(cramped.top >= 8);
});

test('a relative path never climbs out of the folder', () => {
  assert.equal(preview.resolveFolderPath('docs/a.md', 'guide.md'), 'docs/guide.md');
  assert.equal(preview.resolveFolderPath('docs/a.md', '../notes/b.md'), 'notes/b.md');
  assert.equal(preview.resolveFolderPath('docs/a.md', './b.md'), 'docs/b.md');
  assert.equal(preview.resolveFolderPath('docs/a.md', '../../escape.md'), null);
  assert.equal(preview.resolveFolderPath('a.md', '../b.md'), null);
});

test('a source summary stops at three blocks and can start at a heading', () => {
  const source = ['# Top', '', 'One.', '', '## Later', '', 'Two.', '', 'Three.', '', 'Four.'].join(
    '\n',
  );

  assert.deepEqual(preview.summarizeSource(source), ['# Top', 'One.', '## Later']);
  assert.deepEqual(preview.summarizeSource(source, 'later'), ['## Later', 'Two.', 'Three.']);
  // A fragment naming nothing falls back to the file's opening rather than
  // reporting an error about a file that is plainly there.
  assert.deepEqual(preview.summarizeSource(source, 'nope')[0], '# Top');
});
