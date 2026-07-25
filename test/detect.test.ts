import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCandidateUrl, isMarkdownContentType, originPattern } from '../lib/detect.ts';

test('accepts every supported extension', () => {
  for (const ext of ['md', 'markdown', 'mkd', 'mdx']) {
    assert.equal(isCandidateUrl(`https://example.com/readme.${ext}`), true, ext);
  }
});

test('is case insensitive and tolerates a trailing slash', () => {
  assert.equal(isCandidateUrl('https://example.com/README.MD'), true);
  assert.equal(isCandidateUrl('https://example.com/docs/a.Md/'), true);
});

test('rejects non-markdown paths and unsupported schemes', () => {
  assert.equal(isCandidateUrl('https://example.com/index.html'), false);
  assert.equal(isCandidateUrl('https://example.com/'), false);
  assert.equal(isCandidateUrl('chrome://extensions'), false);
  assert.equal(isCandidateUrl('data:text/plain,hello'), false);
  assert.equal(isCandidateUrl('not a url'), false);
});

test('accepts local files', () => {
  assert.equal(isCandidateUrl('file:///Users/x/notes.md'), true);
});

test('skips hosts that render markdown themselves, including subdomains', () => {
  assert.equal(isCandidateUrl('https://github.com/o/r/blob/main/README.md'), false);
  assert.equal(isCandidateUrl('https://docs.readthedocs.io/guide.md'), false);
  assert.equal(isCandidateUrl('https://team.gitbook.io/page.md'), false);
});

test('raw hosts win over their parent domain', () => {
  assert.equal(
    isCandidateUrl('https://raw.githubusercontent.com/o/r/main/README.md'),
    true,
  );
  assert.equal(
    isCandidateUrl('https://gist.githubusercontent.com/u/id/raw/f.md'),
    true,
  );
});

test('does not treat a lookalike domain as a known host', () => {
  // endsWith('.github.com') must not match "notgithub.com".
  assert.equal(isCandidateUrl('https://notgithub.com/readme.md'), true);
});

test('content types', () => {
  assert.equal(isMarkdownContentType('text/plain'), true);
  assert.equal(isMarkdownContentType('text/markdown'), true);
  assert.equal(isMarkdownContentType('text/x-markdown'), true);
  assert.equal(isMarkdownContentType('text/plain; charset=utf-8'), true);
  assert.equal(isMarkdownContentType('TEXT/PLAIN'), true);
  assert.equal(isMarkdownContentType('text/html'), false);
  assert.equal(isMarkdownContentType('application/octet-stream'), false);
});

test('origin patterns are stripped to scheme and host', () => {
  assert.equal(
    originPattern('https://example.com/deep/path.md?x=1'),
    'https://example.com/*',
  );
  assert.equal(originPattern('http://localhost:3000/a.md'), 'http://localhost/*');
  assert.equal(originPattern('file:///Users/x/notes.md'), null);
});
