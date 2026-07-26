/**
 * Frontmatter, in both halves.
 *
 * The parsing half is a pure function and is tested as one. The stripping half
 * is tested through the real pipeline — `renderMarkdown` with the plugin
 * applied and then without it — because the claim is not "the rule ran", it is
 * "the block is gone from the HTML, and disabling the plugin puts it back
 * exactly as markdown would have rendered it".
 *
 * The card itself is a `.tsx` the bare runner cannot mount, so what is asserted
 * of it here is everything that is not pixels: the contribution reaches the
 * region, it leaves with the plugin, the setting round-trips, and the model the
 * component renders is strings all the way down — which is the whole of the
 * no-HTML-injection guarantee.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import type { AnyPlugin, PluginContext } from '../lib/plugins/types.ts';

import {
  cardModel,
  createFrontmatterPlugin,
  formatValue,
  parseFrontmatter,
  splitFrontmatter,
  stripFrontmatter,
  FRONTMATTER_REGION,
  type FrontmatterSettings,
} from '../plugins/frontmatter/plugin.ts';

import { MARKDOWN_PLUGINS, loadPipeline, without } from './markdown-pipeline.ts';

const NOTHING = () => null;
const plugin = createFrontmatterPlugin(NOTHING);

/** The registry set, which already carries this plugin, and the same set without it. */
const WITH: readonly AnyPlugin[] = MARKDOWN_PLUGINS;
const WITHOUT: readonly AnyPlugin[] = without('frontmatter');

let pipeline: Awaited<ReturnType<typeof loadPipeline>>;

before(async () => {
  pipeline = await loadPipeline(WITH);
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

/* -------------------------------------------------------------------------- */
/* Valid YAML                                                                  */
/* -------------------------------------------------------------------------- */

const VALID = [
  '---',
  'title: Release Notes',
  'author: Ada Lovelace',
  'date: 2024-03-05',
  'tags: [release, notes]',
  'draft: false',
  '---',
  '',
  '# Body',
  '',
  'Text.',
].join('\n');

test('valid frontmatter parses to fields and leaves the document behind', () => {
  const matter = parseFrontmatter(VALID);
  assert.ok(matter);
  assert.equal(matter.error, null);
  assert.equal(matter.data?.title, 'Release Notes');
  assert.equal(matter.rest, '# Body\n\nText.');

  const model = cardModel(matter.data!);
  assert.equal(model.title, 'Release Notes');
  assert.equal(model.author, 'Ada Lovelace');
  assert.equal(model.date, '2024-03-05');
  assert.deepEqual(model.tags, ['release', 'notes']);
  assert.deepEqual(
    model.fields.map((field) => [field.key, field.value]),
    [['draft', 'false']],
  );
});

test('the block never reaches the rendered HTML', () => {
  const { html } = pipeline.render(VALID);
  assert.ok(!html.includes('Release Notes'), html);
  assert.ok(!html.includes('<hr'), html);
  assert.ok(!html.includes('<table'), html);
  assert.match(html, /<h1[^>]*>Body<\/h1>/);
});

test('every value the card renders is a string, whatever the YAML held', () => {
  const source = [
    '---',
    'title: [not, a, string]',
    'author:',
    '  name: Ada',
    '  handle: ada',
    'date: 2024-03-05T09:30:00Z',
    'tags: alpha, beta',
    'count: 3',
    'nothing: ~',
    'nested: { a: { b: c } }',
    '---',
    'Body.',
  ].join('\n');

  const matter = parseFrontmatter(source);
  const model = cardModel(matter!.data!);

  const leaves = [
    model.title,
    model.author,
    model.date,
    ...model.tags,
    ...model.fields.flatMap((field) => [field.key, field.value]),
  ];
  for (const leaf of leaves) {
    assert.equal(typeof leaf, 'string', `${String(leaf)} is not a string`);
  }

  assert.equal(model.title, 'not, a, string');
  assert.equal(model.author, 'name: Ada, handle: ada');
  assert.equal(model.date, '2024-03-05T09:30:00Z');
  assert.deepEqual(model.tags, ['alpha', 'beta']);
  assert.equal(formatValue(null), '');
});

test('markup in a value stays a value — it is text, never HTML', () => {
  const source = ['---', 'title: <img src=x onerror=alert(1)>', '---', 'Body.'].join('\n');
  const model = cardModel(parseFrontmatter(source)!.data!);

  // The card renders this as a React text child, which escapes it. What is
  // asserted here is that the model hands the component a string and not a
  // fragment of markup it might be tempted to inject.
  assert.equal(typeof model.title, 'string');
  assert.equal(model.title, '<img src=x onerror=alert(1)>');
});

/* -------------------------------------------------------------------------- */
/* Malformed YAML — the load-bearing case                                      */
/* -------------------------------------------------------------------------- */

const MALFORMED = ['---', 'title: "unterminated', 'tags: [a, b', '  bad: indent', '---', '', 'Body.'].join(
  '\n',
);

test('malformed YAML never throws, and keeps the raw block', () => {
  // Called through `doesNotThrow` for the assertion, and again for the value:
  // the callback's return type is `void`, and narrowing an assigned outer
  // variable back out of it costs more casts than a second call costs cycles.
  assert.doesNotThrow(() => parseFrontmatter(MALFORMED));
  const parsed = parseFrontmatter(MALFORMED);

  assert.ok(parsed);
  assert.equal(parsed.data, null);
  assert.ok(parsed.error && parsed.error.length > 0);
  // The raw block is what the card shows, and it is the author's text verbatim.
  assert.ok(parsed.raw.startsWith('---\n'));
  assert.ok(parsed.raw.includes('title: "unterminated'));
  assert.ok(parsed.raw.trimEnd().endsWith('---'));
  assert.equal(parsed.rest, 'Body.');
});

test('malformed YAML is still stripped, and rendering still succeeds', () => {
  const { html } = pipeline.render(MALFORMED);
  assert.ok(!html.includes('unterminated'), html);
  assert.match(html, /<p>Body\.<\/p>/);
});

test('a block that is not a mapping is shown raw rather than as fields', () => {
  for (const body of ['- one\n- two', 'just a sentence']) {
    const matter = parseFrontmatter(`---\n${body}\n---\n\nBody.`);
    assert.ok(matter, body);
    assert.equal(matter.data, null, body);
    assert.ok(matter.error, body);
  }
});

/* -------------------------------------------------------------------------- */
/* TOML, JSON, and no frontmatter at all                                       */
/* -------------------------------------------------------------------------- */

test('TOML frontmatter is passed through untouched', () => {
  const source = ['+++', 'title = "Release Notes"', '+++', '', '# Body'].join('\n');

  assert.equal(parseFrontmatter(source), null);
  assert.equal(stripFrontmatter(source), source);

  const { html } = pipeline.render(source);
  assert.ok(html.includes('Release Notes'), html);
});

test('JSON frontmatter is passed through untouched', () => {
  const source = ['{', '  "title": "Release Notes"', '}', '', '# Body'].join('\n');

  assert.equal(parseFrontmatter(source), null);
  assert.equal(stripFrontmatter(source), source);

  const { html } = pipeline.render(source);
  assert.ok(html.includes('Release Notes'), html);
});

test('a document with no frontmatter is untouched', () => {
  const source = '# Title\n\nSome text with --- in it.\n';
  assert.equal(parseFrontmatter(source), null);
  assert.equal(stripFrontmatter(source), source);
});

/* -------------------------------------------------------------------------- */
/* The `---` false positive                                                    */
/* -------------------------------------------------------------------------- */

test('a leading horizontal rule is not frontmatter', () => {
  const cases: ReadonlyArray<[what: string, source: string]> = [
    ['rule then heading, no closing fence', '---\n# Title\n\nText.\n'],
    ['rule, blank line, prose', '---\n\nIntro text.\n\n---\n\nMore.\n'],
    ['two rules in a row', '---\n---\n\nText.\n'],
    ['rule then a setext heading underlined by another rule', '---\nTitle\n===\n\nText.\n'],
    ['a rule further down the document', '# Title\n\n---\n\nText.\n'],
    ['a rule written with asterisks', '***\ntitle: x\n***\n\nText.\n'],
  ];

  for (const [what, source] of cases) {
    // The fourth case is the one worth naming: `---\nTitle\n===` has no closing
    // `---` at all, so condition (2) rejects it.
    assert.equal(splitFrontmatter(source), null, what);
    assert.equal(stripFrontmatter(source), source, what);
  }
});

test('the rule at the top of a document still renders as a rule', () => {
  const source = '---\n\nIntro text.\n';
  const { html } = pipeline.render(source);
  assert.match(html, /<hr\s*\/?>/);
  assert.ok(html.includes('Intro text.'), html);
});

test('closing with YAML’s ... marker works, as do longer fences', () => {
  const dots = parseFrontmatter('---\ntitle: A\n...\n\nBody.');
  assert.equal(dots?.data?.title, 'A');
  assert.equal(dots?.rest, 'Body.');

  const long = parseFrontmatter('-----\ntitle: A\n-----\n\nBody.');
  assert.equal(long?.data?.title, 'A');
});

test('CRLF line endings and a BOM are handled', () => {
  const matter = parseFrontmatter('﻿---\r\ntitle: A\r\n---\r\n\r\nBody.\r\n');
  assert.equal(matter?.data?.title, 'A');
  assert.equal(matter?.rest, 'Body.\r\n');
});

/* -------------------------------------------------------------------------- */
/* Enable, disable, residue                                                    */
/* -------------------------------------------------------------------------- */

test('disabling the plugin renders the block exactly as markdown would', () => {
  const enabled = pipeline.render(VALID).html;

  pipeline.use(WITHOUT);
  const disabled = pipeline.render(VALID).html;

  pipeline.use(WITH);
  const again = pipeline.render(VALID).html;

  // Disabled, the block is back — as whatever markdown makes of it, which is
  // the point: the plugin removes it, it does not delete it.
  assert.ok(disabled.includes('Release Notes'), disabled);
  assert.notEqual(enabled, disabled);
  // Re-enabling is byte-identical to the first enable: no rule stacked twice.
  assert.equal(again, enabled);
});

test('the card contributes to document.before and leaves with the plugin', async () => {
  const dom = new JSDOM('<div id="mdv-root"><main class="mdv-body"></main></div>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }

  const host = new PluginHost({
    plugins: [plugin],
    storage: memoryStorage(),
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();

  const contributed = () =>
    host.regions.for(FRONTMATTER_REGION).filter((entry) => entry.pluginId === 'frontmatter');

  assert.equal(contributed().length, 1);

  // Toggled repeatedly: registering on every enable and removing once looks
  // fine until the third toggle.
  for (let round = 0; round < 3; round += 1) {
    await host.setEnabled('frontmatter', false);
    assert.equal(contributed().length, 0, `round ${round}`);
    await host.setEnabled('frontmatter', true);
    assert.equal(contributed().length, 1, `round ${round}`);
  }

  const ctx = host.contextOf('frontmatter') as unknown as PluginContext<FrontmatterSettings>;
  assert.equal(ctx.settings.display, 'card');
  await ctx.updateSettings({ display: 'raw' });
  assert.equal(ctx.settings.display, 'raw');
  // Out-of-schema values fall back rather than reaching the component.
  await ctx.updateSettings({ display: 'nonsense' as never });
  assert.equal(ctx.settings.display, 'card');
});
