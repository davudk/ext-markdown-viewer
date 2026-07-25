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
