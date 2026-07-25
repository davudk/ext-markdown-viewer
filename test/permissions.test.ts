import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_SITES,
  expandOrigin,
  fileMatchPatterns,
  originLabel,
} from '../lib/permissions.ts';

test('a single-site grant expands to that site only', () => {
  assert.deepEqual(expandOrigin('https://example.com/*'), [
    'https://example.com/*.md',
    'https://example.com/*.markdown',
    'https://example.com/*.mkd',
    'https://example.com/*.mdx',
  ]);
});

test('the all-sites grant keeps both wildcards', () => {
  // This is what the "render automatically on every site" setting registers.
  // Narrowing either wildcard here would silently stop it working on http, or
  // on every host but the first.
  assert.deepEqual(expandOrigin(ALL_SITES), [
    '*://*/*.md',
    '*://*/*.markdown',
    '*://*/*.mkd',
    '*://*/*.mdx',
  ]);
});

test('wildcard subdomains are preserved, not flattened', () => {
  assert.deepEqual(expandOrigin('https://*.example.com/*'), [
    'https://*.example.com/*.md',
    'https://*.example.com/*.markdown',
    'https://*.example.com/*.mkd',
    'https://*.example.com/*.mdx',
  ]);
});

test('http and https stay distinct', () => {
  assert.equal(expandOrigin('http://example.com/*')[0], 'http://example.com/*.md');
});

test('non-web origins expand to nothing', () => {
  // file:// is a browser-level toggle, never a granted origin, and anything
  // else would be an invalid registration that throws at sync time.
  assert.deepEqual(expandOrigin('file:///*'), []);
  assert.deepEqual(expandOrigin('chrome://extensions/*'), []);
  assert.deepEqual(expandOrigin(''), []);
  assert.deepEqual(expandOrigin('nonsense'), []);
});

test('path globs span slashes, so nested files still match', () => {
  // Chrome match-pattern semantics: `*` in a path crosses `/`. Worth pinning,
  // because `/docs/a.md` matching `/*.md` is the whole reason narrow patterns
  // are safe to register instead of the full origin.
  const [pattern] = expandOrigin('https://example.com/*');
  const toRegExp = (p: string) =>
    new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

  assert.ok(toRegExp(pattern).test('https://example.com/docs/deep/a.md'));
  assert.ok(toRegExp(pattern).test('https://example.com/a.md'));
  assert.ok(!toRegExp(pattern).test('https://example.com/a.html'));
});

test('file patterns cover every supported extension', () => {
  assert.deepEqual(fileMatchPatterns(), [
    'file:///*.md',
    'file:///*.markdown',
    'file:///*.mkd',
    'file:///*.mdx',
  ]);
});

test('origin labels are readable', () => {
  assert.equal(originLabel('https://example.com/*'), 'example.com');
  assert.equal(originLabel('http://localhost/*'), 'localhost');
  assert.equal(originLabel('https://*.example.com/*'), '*.example.com');
  assert.equal(originLabel(ALL_SITES), '*');
});
