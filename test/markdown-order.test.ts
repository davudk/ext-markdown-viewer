/**
 * The markdown pipeline is order-independent, and this is how that is known.
 *
 * Before the migration the parser was one function, and the ordering it relied
 * on was the order of statements in it — `mdv_code_span_wins` inserted before
 * `math_inline`, `mdv_wikilink` before `link`, the outline rule pushed after
 * `markdown-it-anchor`. Split across nine files, the same coupling becomes a
 * registry list someone can reorder in a merge without a single test noticing.
 *
 * So every case that ordering is load-bearing for is rendered twice: once with
 * the registry in its documented order, once with it reversed. Both go through
 * the real `sortPlugins`, so an `after:` that is missing or wrong fails here
 * rather than in a browser.
 *
 * The results are compared to each other, not to a golden string: what is being
 * asserted is that load order cannot change the output, and a literal would
 * quietly turn this into a snapshot test of nine plugins instead.
 */

import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { MATH_PLACEHOLDER_CLASS } from '../lib/config.ts';
import { MARKDOWN_PLUGINS, loadPipeline } from './markdown-pipeline.ts';

/** Each case names the rule ordering it would catch the breakage of. */
const CASES: ReadonlyArray<{ what: string; source: string }> = [
  {
    what: 'mdv_code_span_wins before math_inline',
    source: 'A $ B `c` D $ E, and `$x$`, and $y^2$, and it costs $5 and $10',
  },
  {
    what: 'mdv_wikilink before link',
    source: 'See [[Release Notes]] and [a link](x.md) and [[Page#Some Heading|here]].',
  },
  {
    what: 'mdv_outline after markdown-it-anchor assigns ids',
    source: '# Getting Started\n\n## Options\n\n## Options\n\n## ???\n\n## The `render` :rocket:',
  },
  {
    what: 'mdv_table_align after any table rule',
    source: '| a | b |\n| :-- | --: |\n| wide || \n',
  },
  {
    what: 'alerts and containers rendering one shape',
    source: '> [!NOTE] Heads up\n> Body.\n\n:::danger Do not\nBoom.\n:::\n',
  },
  {
    what: 'mdv_frontmatter before normalize',
    source: '---\ntitle: Release Notes\ntags: [a, b]\n---\n\n# Body\n\nText.\n',
  },
  {
    what: 'mermaid fences, footnotes and task lists together',
    source: '- [x] done[^1]\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\n[^1]: note :tada:',
  },
];

let pipeline: Awaited<ReturnType<typeof loadPipeline>>;

before(async () => {
  pipeline = await loadPipeline();
});

for (const { what, source } of CASES) {
  test(`reversing the registry does not change: ${what}`, () => {
    pipeline.use(MARKDOWN_PLUGINS);
    const forward = pipeline.render(source);

    pipeline.use([...MARKDOWN_PLUGINS].reverse());
    const backward = pipeline.render(source);

    pipeline.use(MARKDOWN_PLUGINS);

    assert.equal(backward.html, forward.html);
    assert.deepEqual(backward.headings, forward.headings);
  });
}

test('every ordering of the registry produces the same document', () => {
  // Reversal is the obvious adversary, not the only one. A few shuffles cost
  // nothing and cover the pairwise swaps a reversal happens to preserve.
  const source = CASES.map((c) => c.source).join('\n\n');

  pipeline.use(MARKDOWN_PLUGINS);
  const expected = pipeline.render(source);

  // A fixed seed rather than Math.random: a test that fails one run in twenty
  // and passes on rerun teaches everyone to rerun it.
  let seed = 20240607;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const shuffled = [...MARKDOWN_PLUGINS];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    pipeline.use(shuffled);
    const actual = pipeline.render(source);
    assert.equal(
      actual.html,
      expected.html,
      `load order changed the output: ${shuffled.map((p) => p.id).join(', ')}`,
    );
    assert.deepEqual(actual.headings, expected.headings);
  }

  pipeline.use(MARKDOWN_PLUGINS);
});

test('the pipeline still renders and sanitizes with no host at all', async () => {
  // The shell installs the host; a shell that forgot to must degrade to
  // CommonMark, not to a blank page or a throw.
  const markdown = await import('../lib/markdown.ts');
  markdown.setMarkdownHost(null);

  const { html, headings } = markdown.renderMarkdown('# Title\n\n<script>alert(1)</script>');
  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(!html.includes('<script'), 'DOMPurify is not sanitizing');
  assert.deepEqual(headings, []);

  pipeline.use(MARKDOWN_PLUGINS);
});
