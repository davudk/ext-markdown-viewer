/**
 * The markdown pipeline, including the sanitization it is responsible for.
 *
 * jsdom rather than a lighter DOM shim on purpose: DOMPurify checks for
 * `document.implementation` and, when it is missing, sets `isSupported = false`
 * and returns its input **unchanged**. Under such a shim every XSS assertion
 * here would pass while the payloads sailed through untouched. The first test
 * exists to catch exactly that.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  MATH_DISPLAY_CLASS,
  MATH_INLINE_CLASS,
  MATH_PLACEHOLDER_CLASS,
} from '../lib/config.ts';

let renderMarkdown: typeof import('../lib/markdown.ts').renderMarkdown;

before(async () => {
  const dom = new JSDOM('', { url: 'https://example.test/' });
  // DOMPurify binds to whatever `window` exists at import time, so the globals
  // have to be in place before the module is loaded.
  // Assigned through a loose view of globalThis: these are DOM globals that
  // node's type definitions do not declare, and the alternative is seven casts.
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    'window',
    'document',
    'Node',
    'DocumentFragment',
    'HTMLTemplateElement',
    'NodeFilter',
    'trustedTypes',
  ]) {
    globals[name] =
      name === 'window'
        ? dom.window
        : (dom.window as unknown as Record<string, unknown>)[name];
  }

  ({ renderMarkdown } = await import('../lib/markdown.ts'));
});

test('sanitization is actually running', () => {
  // If DOMPurify silently no-ops, this is the only test that fails, and every
  // other security assertion in this file becomes meaningless. Keep it first.
  const { html } = renderMarkdown('<script>alert(1)</script>\n');
  assert.ok(!html.includes('<script'), 'DOMPurify is not sanitizing');
});

test('strips scripts, handlers, and javascript: urls', () => {
  const { html } = renderMarkdown(
    [
      '<script>window.x = 1</script>',
      '<img src="x" onerror="window.x = 1">',
      '<a href="javascript:window.x=1">click</a>',
      '<iframe src="https://example.com"></iframe>',
      '<style>body{display:none}</style>',
      '<div onclick="window.x=1">hi</div>',
    ].join('\n\n'),
  );

  assert.ok(!/<script/i.test(html));
  assert.ok(!/<iframe/i.test(html));
  assert.ok(!/<style/i.test(html));
  assert.ok(!/\son\w+=/i.test(html), 'an event handler survived');
  assert.ok(!/javascript:/i.test(html));
});

test('keeps the GFM output a stricter allowlist would eat', () => {
  const { html } = renderMarkdown(
    ['- [x] done', '- [ ] todo', '', '| a | b |', '| :-- | --: |', '| 1 | 2 |'].join('\n'),
  );

  assert.ok(html.includes('type="checkbox"'), 'task list checkboxes were dropped');
  assert.ok(/align="(left|right)"/.test(html), 'table alignment was dropped');
});

test('highlights known languages and survives unknown ones', () => {
  const known = renderMarkdown('```js\nconst x = 1;\n```');
  assert.ok(known.html.includes('hljs language-js'));
  assert.ok(known.html.includes('hljs-keyword'));

  const unknown = renderMarkdown('```definitely-not-real\nplain text\n```');
  assert.ok(unknown.html.includes('<code'), 'unknown language should still render');
});

test('collects a heading outline with GitHub-compatible slugs', () => {
  const { headings, html } = renderMarkdown(
    ['# Getting Started', '## Install & Setup', '### Notes'].join('\n\n'),
  );

  assert.deepEqual(
    headings.map((h) => [h.level, h.id, h.text]),
    [
      [1, 'getting-started', 'Getting Started'],
      [2, 'install--setup', 'Install & Setup'],
      [3, 'notes', 'Notes'],
    ],
  );
  assert.ok(html.includes('id="getting-started"'));
});

test('disambiguates repeated headings the way GitHub does', () => {
  const { headings } = renderMarkdown(['## Options', '## Options', '## Options'].join('\n\n'));
  assert.deepEqual(headings.map((h) => h.id), ['options', 'options-1', 'options-2']);
});

test('headings containing markup produce clean text and slugs', () => {
  const { headings } = renderMarkdown('## The `render` **function**');
  assert.equal(headings[0].text, 'The render function');
  assert.equal(headings[0].id, 'the-render-function');
});

test('a heading with no sluggable characters still gets an id', () => {
  const { headings } = renderMarkdown('## ???');
  assert.equal(headings.length, 1);
  assert.ok(headings[0].id.length > 0);
});

test('outline never references a heading sanitization removed', () => {
  const { html, headings } = renderMarkdown('# Fine\n\n## Also fine');
  for (const heading of headings) {
    assert.ok(html.includes(`id="${heading.id}"`), `${heading.id} is not in the output`);
  }
});

test('renders footnotes', () => {
  const { html } = renderMarkdown('Text with a note[^1]\n\n[^1]: The note.');
  assert.ok(/footnote/i.test(html), 'no footnote markup emitted');
  assert.ok(html.includes('The note.'));
});

test('resolves emoji shortnames offline', () => {
  const { html } = renderMarkdown('Ship it :rocket:');
  assert.ok(html.includes('🚀'), 'emoji shortname was not resolved');
});

test('leaves unknown shortnames alone', () => {
  const { html } = renderMarkdown('a :definitely_not_an_emoji: b');
  assert.ok(html.includes(':definitely_not_an_emoji:'));
});

test('malformed input degrades instead of throwing', () => {
  const inputs = [
    '```js\nunclosed fence',
    '| a |\n| --- |\n| 1 | 2 | 3 |',
    '**unclosed',
    '['.repeat(500),
    '',
  ];

  for (const input of inputs) {
    const { html } = renderMarkdown(input);
    assert.equal(typeof html, 'string');
  }
});

test('each parse starts with a fresh slug counter', () => {
  // A shared counter across documents would number the second document's
  // headings as duplicates of the first's.
  const first = renderMarkdown('## Options');
  const second = renderMarkdown('## Options');
  assert.equal(first.headings[0].id, 'options');
  assert.equal(second.headings[0].id, 'options');
});

/* -------------------------------------------------------------------------- */
/* Math must never be read inside code                                         */
/*                                                                             */
/* Under `marked` this held for free: its own codespan and fence tokenizers    */
/* claimed `$…$` before the math extension ever saw the delimiter. markdown-it  */
/* installs the KaTeX rules *before* `backticks`, so none of it transfers and   */
/* every case below is checked rather than assumed.                            */
/* -------------------------------------------------------------------------- */

/**
 * No math anywhere in the output.
 *
 * The parse no longer renders formulae — it emits a placeholder for
 * `entrypoints/katex-addon.ts` to fill in — so this asks whether the tokenizer
 * claimed the `$`, which is the property every test in this section is about.
 */
function hasMath(html: string): boolean {
  return html.includes(`class="${MATH_PLACEHOLDER_CLASS}`);
}

/** The placeholder markup for one formula, TeX included. */
function placeholder(tex: string, kind: string): string {
  return `<span class="${MATH_PLACEHOLDER_CLASS} ${kind}">${tex}</span>`;
}

test('a code span beats math', () => {
  const { html } = renderMarkdown('A `$x$` B');
  assert.ok(html.includes('<code>$x$</code>'), 'the code span was not preserved');
  assert.ok(!hasMath(html));
});

test('math is not read inside a fenced block', () => {
  const { html } = renderMarkdown('```js\nconst a = $$x$$;\n```');
  assert.ok(!hasMath(html));
  assert.ok(html.includes('$$x$$'), 'the TeX should survive as characters');
});

test('math is not read inside an indented block', () => {
  const { html } = renderMarkdown('    $$x$$ and $y$\n');
  assert.ok(!hasMath(html));
  assert.ok(html.includes('$$x$$ and $y$'));
});

test('prose dollars are left alone', () => {
  // Two dollar amounts in one sentence is the shape that reads as a delimiter
  // pair to a naive tokenizer.
  const { html } = renderMarkdown('It costs $5 and $10');
  assert.ok(!hasMath(html));
  assert.ok(html.includes('$5 and $10'));
});

test('math cannot open before a code span and close after it', () => {
  // The case that does not survive the move to markdown-it on its own: the
  // plugin's closing-delimiter scan walks straight through the backticks.
  const { html } = renderMarkdown('A $ B `c` D $ E');
  assert.ok(html.includes('<code>c</code>'), 'the code span was swallowed by math');
  assert.ok(!hasMath(html));
});

test('shell variables in code spans stay code', () => {
  const { html } = renderMarkdown('Set `$HOME` then read `$PATH` and `$ VAR `');
  assert.ok(!hasMath(html));
  assert.ok(html.includes('<code>$HOME</code>'));
  assert.ok(html.includes('<code>$PATH</code>'));
});

test('real math becomes a placeholder carrying its own TeX', () => {
  const inline = renderMarkdown('Inline $x^2$ here.');
  assert.ok(
    inline.html.includes(placeholder('x^2', MATH_INLINE_CLASS)),
    'inline math was not tokenized into a placeholder',
  );

  const block = renderMarkdown('$$\n\\frac{a}{b}\n$$\n');
  assert.ok(block.html.includes(MATH_DISPLAY_CLASS), 'display math was not tokenized');
  assert.ok(block.html.includes('\\frac{a}{b}'), 'the TeX did not survive the parse');
});

test('the parse renders no KaTeX at all', () => {
  // The acceptance criterion, at the only place it can be asserted without a
  // browser: a document with math still costs the base bundle nothing, because
  // nothing here calls KaTeX. The add-on is what turns these into formulae.
  const { html } = renderMarkdown('$x^2$ and $$\\frac{a}{b}$$');
  assert.ok(!html.includes('class="katex'), 'the parser rendered KaTeX markup');
  assert.ok(!html.includes('<math'), 'the parser emitted MathML');
});

test('a placeholder cannot carry markup out of the TeX', () => {
  // The TeX is text content, and text content is escaped by construction —
  // which is also why it is not a `data-` attribute: ALLOW_DATA_ATTR is off.
  const { html } = renderMarkdown('$</span><img src=x onerror=alert(1)>$');
  assert.ok(hasMath(html), 'the formula was not tokenized');
  assert.ok(!html.includes('<img'), 'markup escaped the placeholder');
  assert.ok(html.includes('&lt;'), 'the TeX was not escaped');
});

test('a formula that never reaches the add-on still reads as its source', () => {
  // Nothing injects the add-on in a test, so this *is* the un-rendered case:
  // the reader sees the TeX rather than an empty gap.
  const { html } = renderMarkdown('$E = mc^2$');
  assert.ok(html.includes('E = mc^2'));
});

test('math and code spans coexist in one paragraph', () => {
  const { html } = renderMarkdown('$a$ then `b` then $c$');
  assert.ok(html.includes('<code>b</code>'));
  assert.equal(
    html.match(new RegExp(`class="${MATH_PLACEHOLDER_CLASS} `, 'g'))?.length,
    2,
    'both formulae should be tokenized',
  );
});

test('raw MathML is no longer part of the allowlist', () => {
  // PURIFY_CONFIG dropped the mathMl profile and the hand-reopened
  // `semantics`/`annotation` when math stopped being rendered here. A document
  // that hand-writes MathML degrades to its text; it does not reach the DOM.
  const { html } = renderMarkdown(
    '<math><semantics><mi>x</mi><annotation encoding="application/x-tex">x</annotation></semantics></math>',
  );
  assert.ok(!html.includes('<math'), 'MathML survived sanitization');
  assert.ok(!html.includes('<annotation'), 'an annotation survived sanitization');
});

/* -------------------------------------------------------------------------- */
/* Output shape the rest of the extension keys off                             */
/* -------------------------------------------------------------------------- */

test('mermaid fences pass through as characters', () => {
  // The add-on reads this block's text back out and parses it, so anything
  // that tokenized it into spans would break every diagram.
  const { html } = renderMarkdown('```mermaid\ngraph TD;\n  A-->B;\n```');
  assert.ok(html.includes('class="hljs language-mermaid"'));
  assert.ok(!html.includes('hljs-'), 'the diagram was highlighted');
  assert.ok(html.includes('graph TD;'));
});

test('a fence with no language still carries the hljs class', () => {
  // `.hljs` is what the stylesheet and the exported one both key off.
  const { html } = renderMarkdown('```\nplain\n```');
  assert.ok(/<pre><code class="hljs">/.test(html));
});

test('table alignment is an attribute, not an inline style', () => {
  // markdown-it and MultiMarkdown both emit `style="text-align:…"`; viewer.css,
  // the exported stylesheet and the DOCX writer all read `align`.
  const { html } = renderMarkdown('| a | b |\n| :-- | --: |\n| 1 | 2 |');
  assert.ok(html.includes('align="left"'));
  assert.ok(html.includes('align="right"'));
  assert.ok(!html.includes('text-align'), 'an inline style survived');
});

/* -------------------------------------------------------------------------- */
/* New block types                                                             */
/* -------------------------------------------------------------------------- */

test('renders every GitHub alert kind', () => {
  for (const marker of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
    const { html } = renderMarkdown(`> [!${marker}]\n> Body.\n`);
    const kind = marker.toLowerCase();
    assert.ok(
      html.includes(`class="mdv-alert mdv-alert-${kind}"`),
      `${marker} did not become an alert`,
    );
    assert.ok(html.includes('<svg'), `${marker} lost its icon to sanitization`);
    assert.ok(html.includes('Body.'));
  }
});

test('an alert takes a title written after the marker', () => {
  const { html } = renderMarkdown('> [!NOTE] Heads up\n> Body.\n');
  assert.ok(html.includes('Heads up'));
  assert.ok(!html.includes('>Note<'));
});

test('an ordinary blockquote is still a blockquote', () => {
  const { html } = renderMarkdown('> Just a quote.\n');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(!html.includes('mdv-alert'));
});

test('containers render as the same shape as alerts', () => {
  const { html } = renderMarkdown(':::tip\nDo the thing.\n:::\n');
  assert.ok(html.includes('class="mdv-alert mdv-alert-tip"'));
  assert.ok(html.includes('Do the thing.'));
});

test('a container maps onto an alert kind and can name its own title', () => {
  // `:::danger` is Docusaurus' spelling of GitHub's CAUTION.
  const { html } = renderMarkdown(':::danger Do not\nBoom.\n:::\n');
  assert.ok(html.includes('class="mdv-alert mdv-alert-caution"'));
  assert.ok(html.includes('Do not'));
});

test('an unknown container name is left as prose', () => {
  const { html } = renderMarkdown(':::nonsense\nBody.\n:::\n');
  assert.ok(!html.includes('mdv-alert'));
});

test('tables carry colspan and rowspan through sanitization', () => {
  const spanned = renderMarkdown('| a | b | c |\n|---|---|---|\n| wide || x |\n');
  assert.ok(spanned.html.includes('colspan="2"'));

  const stacked = renderMarkdown('| a | b |\n|---|---|\n| x | 1 |\n| ^^ | 2 |\n');
  assert.ok(stacked.html.includes('rowspan="2"'));
});

test('two tables in a row stay two tables', () => {
  // MultiMarkdown's `multibody` would fuse these and render the second header
  // separator as a row of literal `---` cells.
  const { html } = renderMarkdown(
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n| c | d |\n|---|---|\n| 3 | 4 |\n',
  );
  assert.equal(html.match(/<table>/g)?.length, 2);
  assert.ok(!html.includes('<td>---</td>'));
});

test('resolves wikilinks to relative markdown siblings', () => {
  const { html } = renderMarkdown('See [[Release Notes]].');
  assert.ok(html.includes('href="Release%20Notes.md"'), html);
  assert.ok(html.includes('class="mdv-wikilink"'));
  assert.ok(html.includes('>Release Notes</a>'));
});

test('wikilinks take a label, a heading, and an extension already present', () => {
  const labelled = renderMarkdown('[[docs/Guide|the guide]]');
  assert.ok(labelled.html.includes('href="docs/Guide.md"'));
  assert.ok(labelled.html.includes('>the guide</a>'));

  // The fragment has to be the slug this file mints, not the heading's text.
  const fragment = renderMarkdown('[[Page#Some Heading]]');
  assert.ok(fragment.html.includes('href="Page.md#some-heading"'));

  const explicit = renderMarkdown('[[Guide.md]]');
  assert.ok(explicit.html.includes('href="Guide.md"'));
  assert.ok(!explicit.html.includes('Guide.md.md'));
});

test('wikilink text is escaped and cannot smuggle markup', () => {
  const { html } = renderMarkdown('[[Tom & Jerry]] [[<img src=x onerror=go()>]]');
  assert.ok(html.includes('Tom &amp; Jerry'));
  // The payload survives as characters inside the link text, which is the
  // point: it is text, not an element, and no handler attribute was created.
  assert.ok(html.includes('&lt;img'));
  assert.ok(!/<img/i.test(html), 'the payload became an element');
});

test('a wikilink cannot carry a javascript: url', () => {
  // markdown-it's own `validateLink` refuses the scheme, so the rule declines
  // and the source is left standing as the text it always was.
  const { html } = renderMarkdown('[[javascript:alert(1)|click]]');
  assert.ok(!/<a/i.test(html), 'a link was created for a refused scheme');
  assert.ok(html.includes('[[javascript:alert(1)|click]]'));
});

test('an absolute target is a link, not a page name', () => {
  const { html } = renderMarkdown('[[https://example.test/page|docs]]');
  assert.ok(html.includes('href="https://example.test/page"'));
  assert.ok(!html.includes('page.md'), 'a suffix was appended to a real URL');
});

test('a wikilink inside a code span is not a link', () => {
  const { html } = renderMarkdown('`[[nope]]`');
  assert.ok(html.includes('<code>[[nope]]</code>'));
  assert.ok(!html.includes('mdv-wikilink'));
});

test('task lists survive as disabled checkboxes', () => {
  const { html } = renderMarkdown('- [x] done\n- [ ] todo\n- plain\n');
  assert.equal(html.match(/type="checkbox"/g)?.length, 2);
  assert.ok(/checked/.test(html), 'the completed item lost its check');
  assert.ok(html.includes('<li>plain</li>'), 'a plain item was mistaken for a task');
});

test('a bracket that is not a task marker is left alone', () => {
  const { html } = renderMarkdown('- [not a task] item\n');
  assert.ok(!html.includes('checkbox'));
});

test('emoji shortcuts are not applied to punctuation', () => {
  // markdown-it-emoji's `full` preset would turn `:)` into an emoji; prose that
  // ends a parenthetical with a colon should not become a smiley.
  const { html } = renderMarkdown('See the note (below:) and smile :)');
  assert.ok(html.includes(':)'));
});

test('raw html a README actually contains is preserved', () => {
  const { html } = renderMarkdown('<details><summary>More</summary>\n\nHidden\n\n</details>');
  assert.ok(html.includes('<details>'));
  assert.ok(html.includes('<summary>More</summary>'));
});
