/**
 * One test per markdown plugin, each asserting the same two things: the syntax
 * renders when the plugin is enabled, and **degrades to the plain text the
 * author typed** when it is not.
 *
 * The second half is the whole point of the migration. A plugin that stays on
 * whatever the setting says is not a plugin, and the failure is invisible from
 * the enabled side — every test in `markdown.test.ts` would still pass. So each
 * pair renders the same source twice against the same pipeline, with only the
 * plugin set changed.
 */

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import hljs from 'highlight.js/lib/common';

import { MATH_PLACEHOLDER_CLASS } from '../lib/config.ts';
import { MARKDOWN_PLUGINS, loadPipeline, without } from './markdown-pipeline.ts';

let pipeline: Awaited<ReturnType<typeof loadPipeline>>;

before(async () => {
  pipeline = await loadPipeline();
});

/**
 * The same source with the plugin on and off.
 *
 * The set is restored afterwards so the tests are order-independent among
 * themselves — which they have to be, since they share one module-level parser.
 */
function bothWays(id: string, source: string): { on: string; off: string } {
  pipeline.use(MARKDOWN_PLUGINS);
  const on = pipeline.render(source).html;

  pipeline.use(without(id));
  const off = pipeline.render(source).html;

  pipeline.use(MARKDOWN_PLUGINS);
  return { on, off };
}

test('footnotes: rendered when enabled, literal when not', () => {
  const { on, off } = bothWays('markdown-footnotes', 'A note[^1]\n\n[^1]: The note.');

  assert.ok(/footnote/i.test(on), 'no footnote markup emitted');
  assert.ok(!/footnote/i.test(off), 'footnote markup survived the plugin being disabled');
  assert.ok(off.includes('[^1]'), 'the reference should read as its own source');
});

test('emoji: resolved when enabled, a shortname when not', () => {
  const { on, off } = bothWays('markdown-emoji', 'Ship it :rocket:');

  assert.ok(on.includes('🚀'));
  assert.ok(!off.includes('🚀'));
  assert.ok(off.includes(':rocket:'));
});

test('extended tables: spans when enabled, cells of literal markers when not', () => {
  // An ordinary GFM table is core markdown-it and must survive either way — it
  // is only the MultiMarkdown *extensions* this plugin owns.
  const { on, off } = bothWays(
    'markdown-tables',
    '| a | b | c |\n|---|---|---|\n| wide || x |\n',
  );

  assert.ok(on.includes('colspan="2"'));
  assert.ok(!off.includes('colspan'), 'a colspan appeared with the plugin disabled');
  assert.ok(off.includes('<table>'), 'the ordinary GFM table should still render');
});

test('extended tables: alignment stays an attribute either way', () => {
  // `mdv_table_align` is deliberately *not* part of this plugin: core tables
  // emit the same inline style, and `lib/export.ts` reads the attribute. If
  // this ever fails, the DOCX writer has silently lost column alignment.
  const { on, off } = bothWays('markdown-tables', '| a | b |\n| :-- | --: |\n| 1 | 2 |');

  for (const [label, html] of [['enabled', on], ['disabled', off]] as const) {
    assert.ok(html.includes('align="left"'), `align missing when ${label}`);
    assert.ok(html.includes('align="right"'), `align missing when ${label}`);
    assert.ok(!html.includes('text-align'), `an inline style survived when ${label}`);
  }
});

test('github alerts: a callout when enabled, a blockquote when not', () => {
  const { on, off } = bothWays('markdown-github-alerts', '> [!WARNING]\n> Body.\n');

  assert.ok(on.includes('class="mdv-alert mdv-alert-warning"'));
  assert.ok(on.includes('<svg'), 'the icon was lost to sanitization');

  assert.ok(!off.includes('mdv-alert'));
  assert.ok(off.includes('<blockquote>'), 'it is a blockquote underneath, and should read as one');
  assert.ok(off.includes('[!WARNING]'));
});

test('containers: a callout when enabled, literal colons when not', () => {
  const { on, off } = bothWays('markdown-containers', ':::tip\nDo the thing.\n:::\n');

  assert.ok(on.includes('class="mdv-alert mdv-alert-tip"'));
  assert.ok(!off.includes('mdv-alert'));
  assert.ok(off.includes(':::tip'), 'the marker should read as its own source');
  assert.ok(off.includes('Do the thing.'), 'the body must never be swallowed');
});

test('math: a placeholder when enabled, a dollar sign when not', () => {
  const { on, off } = bothWays('markdown-math', 'Inline $x^2$ here.');

  assert.ok(on.includes(MATH_PLACEHOLDER_CLASS));
  assert.ok(!off.includes(MATH_PLACEHOLDER_CLASS));
  assert.ok(off.includes('$x^2$'));
});

test('math: code spans beat math whether or not math is enabled', () => {
  // `mdv_code_span_wins` ships with the math tokenizer, so disabling math must
  // take both halves — leaving the guard behind would eat a lone `$`.
  const { on, off } = bothWays('markdown-math', 'A $ B `c` D $ E');

  assert.ok(on.includes('<code>c</code>'), 'the code span was swallowed by math');
  assert.ok(off.includes('<code>c</code>'));
  assert.ok(off.includes('$ B'), 'a dollar disappeared with math disabled');
});

test('mermaid fences: never highlighted when enabled, ordinary code when not', () => {
  // highlight.js ships no mermaid grammar, so without one registered both sides
  // would look identical and this test would prove nothing. Registering one is
  // exactly the future the plugin exists to survive: the full hljs build, or a
  // grammar added upstream, shredding every diagram into token spans.
  hljs.registerLanguage('mermaid', () => ({
    contains: [{ scope: 'keyword', begin: /graph/ }],
  }));

  try {
    const { on, off } = bothWays('markdown-mermaid-fence', '```mermaid\ngraph TD;\n  A-->B;\n```');

    assert.ok(on.includes('class="hljs language-mermaid"'), 'the class the add-on selects on');
    assert.ok(!on.includes('hljs-'), 'the diagram was highlighted');
    assert.ok(on.includes('graph TD;'), 'the source must survive as characters');

    assert.ok(off.includes('hljs-keyword'), 'the registered grammar did not run');
  } finally {
    hljs.unregisterLanguage('mermaid');
  }
});

test('wikilinks: a relative link when enabled, brackets when not', () => {
  const { on, off } = bothWays('markdown-wikilinks', 'See [[Release Notes]].');

  assert.ok(on.includes('href="Release%20Notes.md"'));
  assert.ok(on.includes('class="mdv-wikilink"'));

  assert.ok(!/<a/i.test(off), 'a link was created with the plugin disabled');
  assert.ok(off.includes('[[Release Notes]]'));
});

test('headings: ids and an outline when enabled, neither when not', () => {
  const source = '# Getting Started\n\n## Install & Setup';

  pipeline.use(MARKDOWN_PLUGINS);
  const on = pipeline.render(source);

  pipeline.use(without('markdown-headings'));
  const off = pipeline.render(source);
  pipeline.use(MARKDOWN_PLUGINS);

  assert.deepEqual(
    on.headings.map((h) => [h.level, h.id, h.text]),
    [
      [1, 'getting-started', 'Getting Started'],
      [2, 'install--setup', 'Install & Setup'],
    ],
  );
  assert.ok(on.html.includes('id="getting-started"'));

  // The headings still *render* — they are core markdown. What is gone is the
  // addressability, and with it the outline, which is the correct pairing: an
  // outline entry pointing at an id nothing carries is worse than no entry.
  assert.ok(off.html.includes('<h1>Getting Started</h1>'), 'the heading itself must survive');
  assert.ok(!off.html.includes('id='), 'an id survived with the plugin disabled');
  assert.deepEqual(off.headings, []);
});

test('task lists survive every plugin being disabled', () => {
  // Baseline GFM output, owned by `lib/markdown.ts` rather than by a plugin,
  // because `viewer.css` and the DOCX export read it unconditionally.
  pipeline.use([]);
  const { html } = pipeline.render('- [x] done\n- [ ] todo\n');
  pipeline.use(MARKDOWN_PLUGINS);

  assert.equal(html.match(/type="checkbox"/g)?.length, 2);
  assert.ok(html.includes('checked'));
});

test('sanitization runs whatever the plugin set is', () => {
  // Plugins extend the parser; they can never widen what reaches the DOM,
  // because DOMPurify is downstream of all of them.
  for (const plugins of [MARKDOWN_PLUGINS, []]) {
    pipeline.use(plugins);
    const { html } = pipeline.render('<script>alert(1)</script>\n\n<img src=x onerror=go()>');
    assert.ok(!html.includes('<script'), 'DOMPurify is not sanitizing');
    assert.ok(!/\son\w+=/i.test(html), 'an event handler survived');
  }
  pipeline.use(MARKDOWN_PLUGINS);
});
