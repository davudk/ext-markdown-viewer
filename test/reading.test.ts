/**
 * Word count, reading time, and the walk that feeds them.
 *
 * The counting half is string math and needs no DOM. The walk half does, and
 * gets a real jsdom document rather than a shim: what is being tested is that a
 * `<pre>` takes its whole subtree out of the count and that a table's cells do
 * not merge into one word, and both of those are `matches()` and `childNodes`
 * behaviour rather than anything this module implements itself.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  READING_CJK_PER_MINUTE,
  READING_WORDS_PER_MINUTE,
} from '../lib/config.ts';
import {
  collectProse,
  measureText,
  readingMinutes,
  readingStats,
} from '../lib/reading.ts';

/** A detached `.mdv-body` holding the given markup. */
function body(html: string): Element {
  const dom = new JSDOM(
    `<main class="mdv-body">${html}</main>`,
    { url: 'https://example.test/' },
  );
  return dom.window.document.querySelector('main') as Element;
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                    */
/* -------------------------------------------------------------------------- */

test('an empty document counts nothing and takes no time', () => {
  assert.deepEqual(measureText(''), { words: 0, cjkCharacters: 0 });
  assert.equal(readingMinutes({ words: 0, cjkCharacters: 0 }), 0);

  const stats = readingStats(body(''));
  assert.equal(stats.words, 0);
  assert.equal(stats.codeBlocks, 0);
  assert.equal(stats.minutes, 0);
});

test('whitespace and punctuation are not words', () => {
  // A horizontal rule, a table's own pipes, and a line of dashes are all real
  // text nodes in a rendered document. None of them is anything to read.
  assert.equal(measureText('  \n\t  ').words, 0);
  assert.equal(measureText('--- | | --- — … ‘’ "" ( ) [ ] {}').words, 0);
});

test('attached punctuation stays part of its word', () => {
  assert.equal(measureText("don't").words, 1);
  assert.equal(measureText('state-of-the-art').words, 1);
  assert.equal(measureText('3.14').words, 1);
  assert.equal(measureText('(parenthesised)').words, 1);
  assert.equal(measureText('one two three').words, 3);
});

test('reading time comes from the configured speeds', () => {
  const oneMinute = { words: READING_WORDS_PER_MINUTE, cjkCharacters: 0 };
  assert.equal(readingMinutes(oneMinute), 1);
  assert.equal(
    readingMinutes({ words: READING_WORDS_PER_MINUTE * 6, cjkCharacters: 0 }),
    6,
  );

  // Anything at all is a minute; "0 min read" tells the reader nothing.
  assert.equal(readingMinutes({ words: 1, cjkCharacters: 0 }), 1);
});

/* -------------------------------------------------------------------------- */
/* CJK                                                                         */
/* -------------------------------------------------------------------------- */

test('CJK is counted per character, not per whitespace run', () => {
  // Twelve characters with no spaces anywhere. Counting whitespace tokens would
  // report this as one word and a reading time of nothing.
  const counted = measureText('这是一段没有空格的中文文本');
  assert.equal(counted.cjkCharacters, 13);
  assert.equal(counted.words, 13);

  const japanese = measureText('これはひらがなとカタカナです');
  assert.equal(japanese.cjkCharacters, japanese.words);
  assert.ok(japanese.words > 1);

  const korean = measureText('한국어 문장입니다');
  assert.equal(korean.cjkCharacters, korean.words);
});

test('CJK characters are timed at the character rate', () => {
  assert.equal(
    readingMinutes({
      words: READING_CJK_PER_MINUTE,
      cjkCharacters: READING_CJK_PER_MINUTE,
    }),
    1,
  );

  // The same number of units is quicker as CJK than as English words, which is
  // the whole reason the two are timed apart.
  const units = READING_CJK_PER_MINUTE;
  assert.ok(
    readingMinutes({ words: units, cjkCharacters: units }) <
      readingMinutes({ words: units, cjkCharacters: 0 }),
  );
});

test('mixed scripts count once each and are timed together', () => {
  const counted = measureText('The word 中文 means Chinese');
  // four Latin words plus two characters — the characters must not also be
  // counted as one whitespace-delimited token.
  assert.equal(counted.cjkCharacters, 2);
  assert.equal(counted.words, 6);

  const minutes = readingMinutes({
    words: READING_WORDS_PER_MINUTE / 2 + READING_CJK_PER_MINUTE / 2,
    cjkCharacters: READING_CJK_PER_MINUTE / 2,
  });
  assert.equal(minutes, 1);
});

/* -------------------------------------------------------------------------- */
/* The walk                                                                    */
/* -------------------------------------------------------------------------- */

test('code blocks are excluded and counted', () => {
  const stats = readingStats(
    body(
      '<p>Install it:</p>' +
        '<pre><code>const a = 1;\nconst b = 2;\nexport default a + b;</code></pre>' +
        '<pre><code>npm install everything at once</code></pre>',
    ),
  );

  assert.equal(stats.words, 2, 'only the sentence should count');
  assert.equal(stats.codeBlocks, 2);
});

test('a document that is only code reads as nothing to read', () => {
  const stats = readingStats(
    body('<pre><code>key = value\nother = thing</code></pre>'),
  );

  assert.equal(stats.words, 0);
  assert.equal(stats.minutes, 0);
  assert.equal(stats.codeBlocks, 1);
});

test('inline code counts, because it is read as part of the sentence', () => {
  const stats = readingStats(body('<p>Run <code>npm install</code> first</p>'));
  assert.equal(stats.words, 4);
  assert.equal(stats.codeBlocks, 0);
});

test('table cells do not merge into one word', () => {
  const stats = readingStats(
    body(
      '<table><thead><tr><th>Option</th><th>Meaning</th></tr></thead>' +
        '<tbody><tr><td>alpha</td><td>first</td></tr>' +
        '<tr><td>beta</td><td>second</td></tr></tbody></table>',
    ),
  );

  assert.equal(stats.words, 6);
});

test('block boundaries separate, inline markup does not', () => {
  assert.equal(readingStats(body('<p>one</p><p>two</p>')).words, 2);
  // `**hel**lo` is one word on screen and has to stay one word here.
  assert.equal(readingStats(body('<p><strong>hel</strong>lo</p>')).words, 1);
});

test('the viewer’s own chrome is not part of the document', () => {
  // Document.tsx grafts a copy button onto every code block and an anchor onto
  // every heading; their faces are real text nodes sitting in the body.
  const stats = readingStats(
    body(
      '<h2 id="x">Title<a class="mdv-anchor"><span>Copied</span></a></h2>' +
        '<div class="mdv-code"><button class="mdv-copy">Copy Copied Failed</button>' +
        '<pre><code>x</code></pre></div>' +
        '<p data-mdv-chrome>1 min read</p>',
    ),
  );

  assert.equal(stats.words, 1, 'only the heading is the document');
});

test('KaTeX MathML twins are not counted twice', () => {
  const stats = readingStats(
    body(
      '<p><span class="katex"><span class="katex-mathml">alpha beta gamma</span>' +
        '<span class="katex-html">αβγ</span></span> follows</p>',
    ),
  );

  // The MathML is a duplicate of what is drawn beside it; only the visible half
  // and the surrounding prose count.
  assert.equal(stats.words, 2);
});

test('a rendered diagram is not prose', () => {
  const stats = readingStats(
    body('<p>See below</p><svg><text>alpha</text><text>beta</text></svg>'),
  );

  assert.equal(stats.words, 2);
});

test('the walk survives deep nesting without recursing', () => {
  // Quoted mail and generated HTML nest arbitrarily; a recursive walk is the
  // one implementation that falls over on it. Built through the DOM rather than
  // by parsing markup, because the parser is the slow part and it is not what
  // is under test.
  const document = body('').ownerDocument as Document;
  // Detached, and built leaf-first: jsdom recurses over ancestors on every
  // insertion into a connected tree, which would blow the stack before the
  // walk under test ever ran.
  let deepest = document.createElement('div');
  deepest.append(document.createTextNode('word'));

  for (let i = 0; i < 20_000; i += 1) {
    const parent = document.createElement('div');
    parent.append(deepest);
    deepest = parent;
  }

  assert.equal(readingStats(deepest).words, 1);
});

test('collectProse reports the text it counted', () => {
  const { text, codeBlocks } = collectProse(
    body('<p>alpha</p><pre><code>beta</code></pre><p>gamma</p>'),
  );

  assert.ok(text.includes('alpha'));
  assert.ok(text.includes('gamma'));
  assert.ok(!text.includes('beta'), 'code leaked into the counted text');
  assert.equal(codeBlocks, 1);
});
