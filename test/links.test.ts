/**
 * Link classification and the indicator pass over the document.
 *
 * The classification half needs no DOM — that is the point of it — so most of
 * this file runs against plain strings. The marking half gets jsdom, because
 * the density rule is about where a link sits relative to its neighbours and
 * there is no honest way to test that without real elements.
 *
 * Nothing here has a network fixture, and there is nothing to mock: a
 * classifier that made a request would be a bug this file could not see, so the
 * guarantee is enforced by `scripts/audit-network.mjs` instead.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  EXTERNAL_LINK_ATTRIBUTE,
  classifyLink,
  clearExternalLinks,
  isExternalLink,
  markExternalLinks,
} from '../lib/links.ts';

const PAGE = 'https://example.test/docs/readme.md';

let dom: JSDOM;

/** Parses a fragment of rendered document HTML into a `.mdv-body`-alike root. */
function body(html: string): Element {
  const root = dom.window.document.createElement('main');
  root.className = 'mdv-body';
  root.innerHTML = html;
  return root;
}

/** The hrefs the pass decided leave the document, in document order. */
function marked(root: Element): string[] {
  return [...root.querySelectorAll(`a[${EXTERNAL_LINK_ATTRIBUTE}]`)].map(
    (link) => link.getAttribute('href') ?? '',
  );
}

before(() => {
  dom = new JSDOM('', { url: PAGE });
});

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

test('the destination decides the kind', () => {
  const cases: Array<[string, string]> = [
    // Same origin, in every shape it is written in.
    ['https://example.test/docs/guide.md', 'internal'],
    ['/other.md', 'internal'],
    ['guide.md', 'internal'],
    ['./guide.md', 'internal'],
    ['../index.md', 'internal'],
    ['guide.md#install', 'internal'],
    // Scheme is not part of the comparison; host is.
    ['http://example.test/docs/guide.md', 'internal'],
    ['https://other.test/', 'external'],
    ['https://sub.example.test/', 'external'],
    // A different port is a different server, whatever the hostname says.
    ['https://example.test:8443/', 'external'],
    // The document already on screen.
    ['#install', 'fragment'],
    ['', 'fragment'],
    // Protocol-relative: the base supplies the scheme, the href the host.
    ['//other.test/x', 'external'],
    ['//example.test/x', 'internal'],
    // Schemes that hand off to another application rather than to a page.
    ['mailto:someone@example.test', 'mail'],
    ['tel:+15551234', 'tel'],
    // Sanitization strips this long before it reaches a document; classify it
    // anyway, so nothing downstream can be talked into treating it as a link.
    ['javascript:alert(1)', 'unsafe'],
    ['data:text/html,<b>x', 'unsafe'],
    // Malformed: an unterminated IPv6 literal is the shortest thing `new URL`
    // refuses outright.
    ['http://[', 'unknown'],
    ['ircs://irc.example.test/room', 'unknown'],
  ];

  for (const [href, kind] of cases) {
    assert.equal(classifyLink(href, PAGE), kind, `${href} should be ${kind}`);
  }
});

test('control characters cannot smuggle a scheme past the switch', () => {
  // Browsers strip tabs and newlines from URLs, so `java\nscript:` is live code
  // in an href. URL parsing strips them too, which is what makes this work.
  assert.equal(classifyLink('java\nscript:alert(1)', PAGE), 'unsafe');
  assert.equal(classifyLink('  javascript:alert(1)  ', PAGE), 'unsafe');
  assert.equal(classifyLink('JavaScript:alert(1)', PAGE), 'unsafe');
});

test('a document opened from disk treats every web link as leaving', () => {
  const local = 'file:///Users/someone/notes/readme.md';

  assert.equal(classifyLink('https://example.test/', local), 'external');
  // Another file beside it is the local equivalent of a relative path.
  assert.equal(classifyLink('guide.md', local), 'internal');
  assert.equal(classifyLink('file:///Users/someone/other.md', local), 'internal');
  assert.equal(classifyLink('#top', local), 'fragment');
});

test('an unusable document url does not take an absolute link down with it', () => {
  assert.equal(classifyLink('https://other.test/', 'not a url'), 'external');
  // With no base to resolve against, a relative href addresses nothing knowable.
  assert.equal(classifyLink('guide.md', 'not a url'), 'unknown');
});

test('isExternalLink is the one question the document asks', () => {
  assert.equal(isExternalLink('https://other.test/', PAGE), true);
  for (const href of ['#x', 'guide.md', 'mailto:a@b.test', 'javascript:x', 'http://[']) {
    assert.equal(isExternalLink(href, PAGE), false, `${href} should not be external`);
  }
});

/* -------------------------------------------------------------------------- */
/* Marking                                                                     */
/* -------------------------------------------------------------------------- */

test('only links that leave the document are marked', () => {
  const root = body(
    '<p>See <a href="https://other.test/">out</a>, <a href="guide.md">near</a>, ' +
      '<a href="#top">up</a> and <a href="mailto:a@b.test">mail</a>.</p>',
  );
  markExternalLinks(root, PAGE);

  assert.deepEqual(marked(root), ['https://other.test/']);
});

test('the pass is idempotent and fully reversible', () => {
  const root = body('<p><a href="https://other.test/">out</a></p>');

  markExternalLinks(root, PAGE);
  markExternalLinks(root, PAGE);
  assert.equal(marked(root).length, 1);

  // Turning the setting off has to leave the document exactly as it was found.
  clearExternalLinks(root);
  assert.equal(root.innerHTML, '<p><a href="https://other.test/">out</a></p>');
});

test('a link-dense block is left alone entirely', () => {
  const links = Array.from(
    { length: 9 },
    (_, i) => `<li><a href="https://other.test/${i}">${i}</a></li>`,
  ).join('');

  const root = body(`<ul>${links}</ul><p><a href="https://other.test/x">lone</a></p>`);
  markExternalLinks(root, PAGE);

  // The list is counted as one block, not as nine items of one link each, or
  // every entry in a bibliography would carry an arrow.
  assert.deepEqual(marked(root), ['https://other.test/x']);
});

test('the density limit is a limit, not a cap', () => {
  const under = body(
    Array.from({ length: 6 }, (_, i) => `<a href="https://other.test/${i}">${i}</a>`)
      .map((link) => `<p>${link}</p>`)
      .join(''),
  );
  markExternalLinks(under, PAGE, 2);
  // Six links in six paragraphs is one link per block; the limit never applies.
  assert.equal(marked(under).length, 6);

  const over = body(
    `<p>${Array.from({ length: 3 }, (_, i) => `<a href="https://other.test/${i}">${i}</a>`).join(' ')}</p>`,
  );
  markExternalLinks(over, PAGE, 2);
  assert.equal(marked(over).length, 0, 'a block over the limit keeps none of them');
});

test('badges and headings get no indicator', () => {
  const root = body(
    [
      '<h2><a href="https://other.test/spec">A linked heading</a></h2>',
      '<p><a href="https://img.test/badge"><img src="b.svg" alt="build"></a></p>',
      '<table><tr><td><a href="https://other.test/cell">in a table</a></td></tr></table>',
      '<p><a href="https://other.test/prose">in prose</a></p>',
    ].join(''),
  );
  markExternalLinks(root, PAGE);

  assert.deepEqual(marked(root), ['https://other.test/prose']);
});

test('an image link that also has text still counts as a link', () => {
  const root = body('<p><a href="https://other.test/"><img src="i.png" alt=""> Read it</a></p>');
  markExternalLinks(root, PAGE);

  assert.equal(marked(root).length, 1);
});
