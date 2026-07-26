/**
 * Broken links, end to end through the real host.
 *
 * Two claims carry the feature and both are asserted here rather than reasoned
 * about: that nothing it must not mark is ever marked — external links above
 * all, and never fetched — and that disabling it leaves the document exactly as
 * it was found, `title` attributes included.
 *
 * The tricky slugs (`install--setup`, `options-1`) are exercised against ids
 * taken from the real pipeline in `test/markdown-pipeline.ts`, not against
 * hand-written strings: the point of the tier is that it agrees with whatever
 * `lib/markdown.ts` minted, and a fixture that re-derives them would agree with
 * itself instead.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import type { Heading } from '../lib/markdown-env.ts';
import { Store } from '../lib/plugins/registry.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../lib/plugins/types.ts';
import { loadPipeline } from './markdown-pipeline.ts';

let createBrokenLinksPlugin: typeof import('../plugins/broken-links/plugin.ts').createBrokenLinksPlugin;
let detect: typeof import('../plugins/broken-links/detect.ts');
let renderMarkdown: (source: string) => { html: string; headings: Heading[] };
let dom: JSDOM;

const DOC_URL = 'https://example.test/docs/guide.md';

before(async () => {
  // The pipeline first: `loadPipeline` installs a jsdom of its own for
  // DOMPurify to bind to, so building ours before it would only have it
  // replaced. DOMPurify keeps its own reference, so the real ids keep coming
  // out of `renderMarkdown` after the globals below point somewhere else.
  ({ render: renderMarkdown } = await loadPipeline());

  dom = new JSDOM('<main class="mdv-body"></main>', { url: DOC_URL });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'CSS']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  // No rAF under the bare runner, so SharedDocument runs passes inline — which
  // is what makes every assertion below synchronous.
  ({ createBrokenLinksPlugin } = await import('../plugins/broken-links/plugin.ts'));
  detect = await import('../plugins/broken-links/detect.ts');
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

function memoryStorage(enabled = true): HostStorage {
  let value: unknown = {
    version: 1,
    global: {},
    plugins: { 'broken-links': { enabled } },
  };
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/** The plugin without its `.tsx` half, which the bare runner cannot load. */
function plugin() {
  return createBrokenLinksPlugin(() => null);
}

/**
 * A stand-in for the files plugin, so tier 2 can be driven without one.
 *
 * It provides the same capability under the same name with the same `Store`
 * shape. That is the whole contract between the two plugins — neither imports
 * the other — so a fake here tests exactly what ships.
 */
function fakeFilesPlugin(store: Store<unknown>): Plugin {
  return {
    id: 'files',
    name: 'Files (test double)',
    description: '',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    setup(ctx) {
      ctx.capabilities.provide('files.browser', store as never);
    },
  };
}

function folderHandle(rootName: string | null, paths: readonly string[]) {
  return {
    supported: true,
    rootName,
    files: paths.map((path) => ({ id: path, name: path, detail: '' })),
    choose: () => {},
    open: () => {},
    read: () => Promise.reject(new Error('not in this test')),
  };
}

interface Scene {
  body: HTMLElement;
  host: PluginHost;
  shared: SharedDocument;
  marked: () => { href: string; tier: string }[];
}

async function scene(options: {
  html: string;
  headings?: readonly Heading[];
  url?: string;
  enabled?: boolean;
  files?: Store<unknown>;
}): Promise<Scene> {
  const body = dom.window.document.querySelector('main.mdv-body')! as unknown as HTMLElement;
  body.innerHTML = options.html;

  const shared = new SharedDocument();
  const host = new PluginHost({
    plugins: options.files ? [fakeFilesPlugin(options.files), plugin()] : [plugin()],
    storage: memoryStorage(options.enabled ?? true),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });

  await host.start();
  shared.update({
    body,
    source: '',
    html: options.html,
    headings: options.headings ?? [{ id: 'overview', text: 'Overview', level: 2 }],
    url: options.url ?? DOC_URL,
    isRaw: false,
  });

  return {
    body,
    host,
    shared,
    marked: () =>
      [...body.querySelectorAll('a[data-mdv-broken]')].map((a) => ({
        href: a.getAttribute('href')!,
        tier: a.getAttribute('data-mdv-broken')!,
      })),
  };
}

/* -------------------------------------------------------------------------- */
/* Tier 1 — anchors                                                            */
/* -------------------------------------------------------------------------- */

test('an anchor that resolves is left alone and one that does not is marked', async () => {
  const { marked } = await scene({
    html: `<p>
      <a href="#overview">good</a>
      <a href="#nowhere">bad</a>
    </p>`,
    headings: [{ id: 'overview', text: 'Overview', level: 2 }],
  });

  assert.deepEqual(marked(), [{ href: '#nowhere', tier: 'anchor' }]);
});

test('the awkward slugs are taken from the pipeline, not re-derived', async () => {
  // `Install & setup` collapses to `install--setup`, and a repeated heading is
  // deduped to `options-1`. Both are cases a second slugger gets wrong.
  const { html, headings } = renderMarkdown(
    ['## Install & setup', '', '## Options', '', '## Options', ''].join('\n'),
  );

  const ids = headings.map((heading) => heading.id);
  assert.ok(ids.includes('install--setup'), `expected install--setup in ${ids.join(', ')}`);
  assert.ok(ids.includes('options-1'), `expected options-1 in ${ids.join(', ')}`);

  const { marked } = await scene({
    html: `${html}
      <p>
        <a href="#install--setup">good</a>
        <a href="#options-1">good</a>
        <a href="#install-setup">bad</a>
        <a href="#options-2">bad</a>
      </p>`,
    headings,
  });

  assert.deepEqual(
    marked().map((link) => link.href),
    ['#install-setup', '#options-2'],
  );
});

test('an id that is in the DOM but not a heading is not broken', async () => {
  // Footnotes mint `#fn1`; raw HTML in a document can mint anything.
  const { marked } = await scene({
    html: `<p><a href="#fn1">note</a><a href="#gone">gone</a></p>
           <section id="fn1">the footnote</section>`,
    headings: [{ id: 'overview', text: 'Overview', level: 2 }],
  });

  assert.deepEqual(
    marked().map((link) => link.href),
    ['#gone'],
  );
});

test('a document with no headings at all has its anchors left alone', async () => {
  // The heading list being empty means unavailable, not "nothing matches".
  const { marked } = await scene({
    html: '<p><a href="#anything">x</a></p>',
    headings: [],
  });

  assert.deepEqual(marked(), []);
});

/* -------------------------------------------------------------------------- */
/* What is never marked                                                        */
/* -------------------------------------------------------------------------- */

test('external, mailto and tel links are never marked — and never fetched', async () => {
  const globals = globalThis as unknown as { fetch?: unknown; XMLHttpRequest?: unknown };
  const realFetch = globals.fetch;
  const realXhr = globals.XMLHttpRequest;

  // Not a spy that records: anything reaching the network here must fail the
  // test outright, because the guarantee is that the code path does not exist.
  globals.fetch = () => {
    throw new Error('broken-links made a network request');
  };
  globals.XMLHttpRequest = function () {
    throw new Error('broken-links opened an XMLHttpRequest');
  };

  try {
    const { marked } = await scene({
      html: `<p>
        <a href="https://elsewhere.example/definitely-404">away</a>
        <a href="http://elsewhere.example/x#nowhere">away with a fragment</a>
        <a href="mailto:someone@example.test">mail</a>
        <a href="tel:+15550100">phone</a>
        <a href="#">top</a>
        <a href="">self</a>
      </p>`,
    });

    assert.deepEqual(marked(), []);
  } finally {
    globals.fetch = realFetch;
    globals.XMLHttpRequest = realXhr;
  }
});

/* -------------------------------------------------------------------------- */
/* Tier 2 — relative files                                                     */
/* -------------------------------------------------------------------------- */

test('with no folder open, tier 2 is silently skipped', async () => {
  const scenes = await scene({
    html: '<p><a href="./missing.md">sibling</a><a href="../gone.md">parent</a></p>',
  });

  // No capability at all: the files plugin is not even in this host.
  assert.deepEqual(scenes.marked(), []);
  // And silently — the pass reports nothing and throws nothing.
  assert.equal(scenes.body.querySelectorAll('[title]').length, 0);
});

test('a folder that is open but holds no path for this document skips tier 2', async () => {
  const files = new Store(folderHandle('notes', ['notes-a.md']));
  const scenes = await scene({
    html: '<p><a href="./missing.md">sibling</a></p>',
    files: files as unknown as Store<unknown>,
    // An http document: nothing relates its address to the open folder.
    url: DOC_URL,
  });

  assert.deepEqual(scenes.marked(), []);
});

test('tier 2 marks a missing sibling and a late folder read applies to the same pass', async () => {
  // Empty at the moment the synchronous pass runs — the files tab has not
  // mounted yet, which is the ordinary startup order.
  const files = new Store(folderHandle(null, []));
  const scenes = await scene({
    html: `<p>
      <a href="./present.md">here</a>
      <a href="./missing.md">gone</a>
      <a href="./unread/deep.md">unknown directory</a>
      <a href="./picture.png">not markdown</a>
      <a href="../../outside.md">above the root</a>
    </p>`,
    url: 'mdv-folder:notes/docs/guide.md',
    files: files as unknown as Store<unknown>,
  });

  assert.deepEqual(scenes.marked(), [], 'tier 2 ran before the folder was known');

  // The late result: the folder tree fills in after the pass already returned.
  files.set(folderHandle('notes', ['docs/guide.md', 'docs/present.md']));

  assert.deepEqual(scenes.marked(), [{ href: './missing.md', tier: 'file' }]);
});

test('turning tier 2 off removes its marks and leaves tier 1 alone', async () => {
  const files = new Store(folderHandle('notes', ['docs/guide.md']));
  const scenes = await scene({
    html: '<p><a href="./missing.md">file</a><a href="#nowhere">anchor</a></p>',
    url: 'mdv-folder:notes/docs/guide.md',
    files: files as unknown as Store<unknown>,
  });

  assert.equal(scenes.marked().length, 2);

  // `contextOf` erases the schema — the host holds plugins with different ones
  // in one array — so the patch is typed by the plugin's own schema here.
  const ctx = scenes.host.contextOf('broken-links') as unknown as {
    updateSettings(patch: { checkRelativeFiles: boolean }): Promise<void>;
  };
  await ctx.updateSettings({ checkRelativeFiles: false });

  assert.deepEqual(scenes.marked(), [{ href: '#nowhere', tier: 'anchor' }]);
});

/* -------------------------------------------------------------------------- */
/* Residue                                                                     */
/* -------------------------------------------------------------------------- */

test('disabling the plugin removes every mark, and restores titles it did not own', async () => {
  const scenes = await scene({
    html: `<p>
      <a href="#nowhere">bad</a>
      <a href="#also-nowhere" title="the author wrote this">bad too</a>
    </p>`,
  });

  assert.equal(scenes.marked().length, 2);
  assert.equal(
    scenes.body.querySelector('a[href="#nowhere"]')!.getAttribute('title'),
    'No heading in this document has the id “nowhere”.',
  );

  await scenes.host.setEnabled('broken-links', false);

  assert.equal(scenes.body.querySelectorAll('[data-mdv-broken]').length, 0);
  assert.equal(
    scenes.body.querySelector('a[href="#nowhere"]')!.getAttribute('title'),
    null,
    'the plugin left behind a title it wrote',
  );
  assert.equal(
    scenes.body.querySelector('a[href="#also-nowhere"]')!.getAttribute('title'),
    'the author wrote this',
    "the plugin stripped a title it did not write",
  );
});

test('toggling repeatedly neither duplicates nor strands marks', async () => {
  const scenes = await scene({ html: '<p><a href="#nowhere">bad</a></p>' });

  for (let i = 0; i < 4; i += 1) {
    await scenes.host.setEnabled('broken-links', false);
    assert.equal(scenes.body.querySelectorAll('[data-mdv-broken]').length, 0);
    await scenes.host.setEnabled('broken-links', true);
  }

  assert.equal(scenes.body.querySelectorAll('[data-mdv-broken]').length, 1);
});

test('the plugin is off until it is asked for', async () => {
  const scenes = await scene({
    html: '<p><a href="#nowhere">bad</a></p>',
    enabled: false,
  });

  assert.deepEqual(scenes.marked(), []);
  assert.equal(plugin().enabledByDefault, false);
});

/* -------------------------------------------------------------------------- */
/* The pure half                                                               */
/* -------------------------------------------------------------------------- */

test('fragment ids are compared decoded', () => {
  assert.equal(detect.fragmentId('#caf%C3%A9'), 'café');
  assert.equal(detect.fragmentId('#'), null);
  assert.equal(detect.fragmentId(''), null);
  // A lone `%` is not decodable; compare what was written rather than throwing.
  assert.equal(detect.fragmentId('#100%'), '100%');
});

test('relative resolution refuses everything it cannot be sure about', () => {
  assert.equal(detect.resolveRelative('docs', './a.md'), 'docs/a.md');
  assert.equal(detect.resolveRelative('docs', '../README.md'), 'README.md');
  assert.equal(detect.resolveRelative('docs/deep', '../a.md'), 'docs/a.md');
  // Wikilinks arrive percent-encoded.
  assert.equal(detect.resolveRelative('', 'Getting%20Started.md'), 'Getting Started.md');

  assert.equal(detect.resolveRelative('docs', '../../up.md'), null, 'above the root');
  assert.equal(detect.resolveRelative('docs', '/rooted.md'), null, 'rooted');
  assert.equal(detect.resolveRelative('docs', 'a.png'), null, 'not markdown');
  assert.equal(detect.resolveRelative('docs', 'https://x.test/a.md'), null, 'absolute');
  assert.equal(detect.resolveRelative('docs', './a.md?v=2'), 'docs/a.md', 'query stripped');
});
