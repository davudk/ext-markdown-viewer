/**
 * Guards on lib/config.ts. It is the file most likely to be edited by hand —
 * adding an extension, allowing a host, introducing a setting — so the shapes
 * everything else assumes are pinned here rather than left to review.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ALL_SITES,
  DEFAULT_SETTINGS,
  MARKDOWN_CONTENT_TYPES,
  MARKDOWN_EXTENSIONS,
  RAW_HOSTS,
  RENDERS_ITS_OWN_MARKDOWN,
  RENDERER_CSS,
  RENDERER_JS,
  RESTRICTED_SCHEMES,
  SUPPORTED_PROTOCOLS,
  THEME_OPTIONS,
} from '../lib/config.ts';

test('extensions are lowercase and dotted', () => {
  // hasMarkdownExtension lowercases the path and does a suffix compare, so an
  // entry missing its dot would match "READMEmd" and an uppercase one never
  // matches at all.
  for (const ext of MARKDOWN_EXTENSIONS) {
    assert.ok(ext.startsWith('.'), `${ext} must start with a dot`);
    assert.equal(ext, ext.toLowerCase(), `${ext} must be lowercase`);
  }
  assert.ok(MARKDOWN_EXTENSIONS.length > 0);
});

test('content types are bare, lowercase, and parameterless', () => {
  for (const type of MARKDOWN_CONTENT_TYPES) {
    assert.equal(type, type.toLowerCase());
    assert.ok(!type.includes(';'), `${type} must not carry parameters`);
    assert.ok(type.includes('/'), `${type} must be a full media type`);
  }
});

test('host lists are bare hostnames', () => {
  for (const host of [...RAW_HOSTS, ...RENDERS_ITS_OWN_MARKDOWN]) {
    assert.ok(!host.includes('/'), `${host} must not contain a path`);
    assert.ok(!host.includes(':'), `${host} must not contain a scheme or port`);
    assert.equal(host, host.toLowerCase());
  }
});

test('a host is never in both lists', () => {
  // isCandidateUrl checks RAW_HOSTS first, so an entry in both would silently
  // win as a raw host and the denylist entry would look broken.
  const raw = new Set(RAW_HOSTS);
  for (const host of RENDERS_ITS_OWN_MARKDOWN) {
    assert.ok(!raw.has(host), `${host} is in both host lists`);
  }
});

test('protocols and schemes are colon-terminated', () => {
  // Compared against `URL.protocol`, which always includes the trailing colon.
  for (const scheme of [...SUPPORTED_PROTOCOLS, ...RESTRICTED_SCHEMES]) {
    assert.ok(scheme.endsWith(':'), `${scheme} must end with a colon`);
  }
});

test('supported and restricted schemes do not overlap', () => {
  const restricted = new Set(RESTRICTED_SCHEMES);
  for (const scheme of SUPPORTED_PROTOCOLS) {
    assert.ok(!restricted.has(scheme), `${scheme} is both supported and restricted`);
  }
});

test('theme options cover the default and have no duplicates', () => {
  const values = THEME_OPTIONS.map((option) => option.value);
  assert.ok(values.includes(DEFAULT_SETTINGS.theme));
  assert.equal(new Set(values).size, values.length);
  for (const { label } of THEME_OPTIONS) assert.ok(label.length > 0);
});

test('injected build paths are relative', () => {
  // chrome.scripting resolves these against the extension root; a leading slash
  // or a URL would fail to resolve at injection time and only at injection time.
  for (const path of [RENDERER_JS, RENDERER_CSS]) {
    assert.ok(!path.startsWith('/'), `${path} must not be absolute`);
    assert.ok(!path.includes('://'), `${path} must not be a URL`);
  }
});

test('the all-sites pattern is a valid match pattern', () => {
  assert.match(ALL_SITES, /^(\*|https?):\/\/[^/]+\/.*$/);
});
