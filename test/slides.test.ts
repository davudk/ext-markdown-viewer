/**
 * Splitting a rendered document into slides.
 *
 * jsdom, because the splitter parses HTML with a `<template>` and moves real
 * nodes between containers — the two things a string-based shim gets wrong in
 * exactly the cases that matter here (nested structures, whitespace between
 * blocks, an `<hr>` that is not where it looks like it is).
 *
 * `lib/slides.ts` reads `document` off the global at call time rather than at
 * import time, so unlike the DOMPurify-backed suites this one only has to have
 * the global in place before the first call.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { splitSlides } from '../lib/slides.ts';

before(() => {
  const dom = new JSDOM('', { url: 'https://example.test/' });
  (globalThis as unknown as Record<string, unknown>).document = dom.window.document;
});

/** The slides' text, flattened — enough to say what landed where. */
function texts(html: string, mode?: Parameters<typeof splitSlides>[1]): string[] {
  return splitSlides(html, mode).map((slide) =>
    slide.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  );
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

test('a horizontal rule ends a slide and is not part of either', () => {
  const slides = splitSlides('<p>one</p><hr><p>two</p><hr><p>three</p>', 'rule');

  assert.equal(slides.length, 3);
  assert.deepEqual(
    slides.map((slide) => slide.html),
    ['<p>one</p>', '<p>two</p>', '<p>three</p>'],
  );
});

test('leading, trailing and doubled rules do not produce blank slides', () => {
  assert.deepEqual(texts('<hr><p>one</p><hr><hr><p>two</p><hr>', 'rule'), [
    'one',
    'two',
  ]);
});

test('only top-level rules cut', () => {
  // A rule inside a blockquote is content. Cutting there would leave the two
  // halves of the quote in different slides, each with an unbalanced element.
  const slides = splitSlides(
    '<blockquote><p>a</p><hr><p>b</p></blockquote><hr><p>next</p>',
    'rule',
  );

  assert.equal(slides.length, 2);
  assert.ok(slides[0].html.includes('<blockquote>'));
  assert.ok(slides[0].html.includes('<hr>'), 'the nested rule was consumed as a break');
});

/* -------------------------------------------------------------------------- */
/* Headings                                                                    */
/* -------------------------------------------------------------------------- */

test('the cut level is the heading level that repeats, not the shallowest', () => {
  // The README shape: one `#` title, then `##` sections. Cutting at the `#`
  // would give a title slide followed by the whole rest of the document.
  const slides = splitSlides(
    [
      '<h1 id="t">Title</h1><p>intro</p>',
      '<h2 id="a">A</h2><p>a body</p>',
      '<h2 id="b">B</h2><p>b body</p>',
    ].join(''),
    'heading',
  );

  assert.deepEqual(
    slides.map((slide) => slide.title),
    ['Title', 'A', 'B'],
  );
});

test('a heading opens its slide rather than closing the one before it', () => {
  const slides = splitSlides('<h2>A</h2><p>a</p><h2>B</h2><p>b</p>', 'heading');

  assert.ok(slides[0].html.startsWith('<h2>A</h2>'));
  assert.ok(slides[1].html.startsWith('<h2>B</h2>'));
});

test('subheadings stay inside the slide they belong to', () => {
  const slides = splitSlides(
    '<h2>A</h2><h3>A.1</h3><p>x</p><h3>A.2</h3><p>y</p><h2>B</h2>',
    'heading',
  );

  assert.equal(slides.length, 2);
  assert.ok(slides[0].html.includes('A.2'));
});

test('content before the first heading becomes the opening slide', () => {
  const slides = splitSlides('<p>preface</p><h2>A</h2><p>a</p><h2>B</h2>', 'heading');

  assert.deepEqual(
    slides.map((slide) => slide.title),
    ['', 'A', 'B'],
  );
});

test('when no level repeats, the shallowest one is the cut', () => {
  const slides = splitSlides('<h1>One</h1><p>a</p><h2>Sub</h2><p>b</p>', 'heading');

  assert.equal(slides.length, 1, 'a single top-level section is a single slide');
});

/* -------------------------------------------------------------------------- */
/* Automatic                                                                   */
/* -------------------------------------------------------------------------- */

test('auto takes the author’s rules when the document has any', () => {
  assert.deepEqual(texts('<h2>A</h2><p>a</p><hr><h2>B</h2><p>b</p>', 'auto'), [
    'A a',
    'B b',
  ]);
});

test('auto falls back to headings when there are no rules', () => {
  // Otherwise the overwhelmingly common document — a README with no `---`
  // anywhere in it — presents as one wall of text.
  assert.deepEqual(texts('<h2>A</h2><p>a</p><h2>B</h2><p>b</p>', 'auto'), [
    'A a',
    'B b',
  ]);
});

/* -------------------------------------------------------------------------- */
/* Degenerate documents                                                        */
/* -------------------------------------------------------------------------- */

test('a document with no separators is one slide, not an empty deck', () => {
  for (const mode of ['auto', 'rule', 'heading'] as const) {
    const slides = splitSlides('<p>just some prose</p><p>and more</p>', mode);
    assert.equal(slides.length, 1, `${mode} should give one slide`);
    assert.ok(slides[0].html.includes('just some prose'));
  }
});

test('an empty document is a deck of one blank slide', () => {
  for (const html of ['', '   ', '\n\n']) {
    const slides = splitSlides(html);
    assert.equal(slides.length, 1);
    assert.equal(slides[0].title, '');
  }
});

test('a deck is never empty, whatever the input', () => {
  for (const html of ['<hr>', '<hr><hr><hr>', '<h2></h2>']) {
    assert.ok(splitSlides(html, 'rule').length >= 1, `${html} produced no slides`);
    assert.ok(splitSlides(html, 'heading').length >= 1, `${html} produced no slides`);
  }
});

test('a slide holding only an image is content, not whitespace', () => {
  const slides = splitSlides('<p>text</p><hr><p><img src="a.png" alt=""></p>', 'rule');

  assert.equal(slides.length, 2);
  assert.ok(slides[1].html.includes('<img'));
});

test('ids do not survive into a slide', () => {
  // The deck and the document it came from are live in the same page. A
  // duplicated id sends `getElementById` to whichever copy is first in the DOM
  // and feeds fixed-position headings to the scroll-memory measurement.
  const slides = splitSlides(
    '<h2 id="install">Install</h2><p id="p1">x</p><hr><p><a href="#install">back</a></p>',
    'rule',
  );

  assert.ok(!slides.some((slide) => slide.html.includes('id=')), 'an id survived');
  // The label is read before the ids go, so it is unaffected.
  assert.equal(slides[0].title, 'Install');
});

test('the title comes from the slide’s own heading and is plain text', () => {
  const slides = splitSlides(
    '<h2>The <code>render</code> function</h2><p>x</p><hr><p>no heading here</p>',
    'rule',
  );

  assert.equal(slides[0].title, 'The render function');
  assert.equal(slides[1].title, '');
});
