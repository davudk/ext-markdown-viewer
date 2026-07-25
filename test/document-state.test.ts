/**
 * Per-document scroll memory.
 *
 * chrome.storage is faked with a plain object rather than mocked: the module
 * only ever calls get/set/remove, and the thing worth testing is what ends up
 * in that object — which keys, how many, and which ones survive.
 *
 * The failure modes exercised here are the ones that are invisible in normal
 * use: a key that quietly forks in two, an eviction that drops the wrong entry,
 * and a storage error that takes the document down with it.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { DOCUMENT_STATE_KEY, DOCUMENT_STATE_LIMIT } from '../lib/config.ts';
import {
  clearAllScrollPositions,
  clearScrollPosition,
  countRememberedDocuments,
  decodePosition,
  documentKey,
  encodePosition,
  loadScrollPosition,
  pruneToLimit,
  saveScrollPosition,
  type AnchorOffset,
  type ScrollPosition,
} from '../lib/document-state.ts';

/* -------------------------------------------------------------------------- */
/* Fake storage                                                                */
/* -------------------------------------------------------------------------- */

type Data = Record<string, unknown>;

/** Installs an in-memory chrome.storage.local and returns its backing object. */
function fakeStorage(): Data {
  const data: Data = {};
  setChrome({
    storage: {
      local: {
        async get(key: string) {
          return key in data ? { [key]: data[key] } : {};
        },
        async set(items: Data) {
          Object.assign(data, items);
        },
        async remove(key: string) {
          delete data[key];
        },
      },
    },
  });
  return data;
}

/** Installs a chrome.storage.local where every call rejects. */
function brokenStorage(): void {
  const fail = async () => {
    throw new Error('storage unavailable');
  };
  setChrome({ storage: { local: { get: fail, set: fail, remove: fail } } });
}

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

/** What is actually persisted, as a plain map. */
function stored(data: Data): Record<string, { usedAt: number }> {
  return (data[DOCUMENT_STATE_KEY] ?? {}) as Record<string, { usedAt: number }>;
}

const position = (anchor: string | null = null, ratio = 0.5): ScrollPosition => ({
  anchor,
  sectionRatio: 0,
  ratio,
});

let data: Data;

beforeEach(() => {
  data = fakeStorage();
});

/* -------------------------------------------------------------------------- */
/* Key normalization                                                           */
/* -------------------------------------------------------------------------- */

test('the fragment is stripped, so one file is one entry', () => {
  // Following a table-of-contents link rewrites the fragment. If it were part
  // of the key, every heading the reader visited would leave its own entry and
  // reopening the file would restore whichever one happened to be written last.
  assert.equal(
    documentKey('https://example.com/a.md#setup'),
    'https://example.com/a.md',
  );
  assert.equal(
    documentKey('https://example.com/a.md#'),
    'https://example.com/a.md',
  );
  assert.equal(documentKey('file:///docs/a.md#x'), 'file:///docs/a.md');
});

test('the query is kept, because it selects the document', () => {
  // `?file=`, `?ref=`, `?raw=1` all change *which* file is served. Stripping
  // the query would make two different documents share one position and
  // silently overwrite each other.
  assert.notEqual(
    documentKey('https://example.com/view?file=a.md'),
    documentKey('https://example.com/view?file=b.md'),
  );
  assert.equal(
    documentKey('https://example.com/view?file=a.md#top'),
    'https://example.com/view?file=a.md',
  );
});

test('urls that do not parse still yield a fragmentless key', () => {
  // Better a slightly odd key than an exception on the way to rendering.
  assert.equal(documentKey('not a url#frag'), 'not a url');
  assert.equal(documentKey(''), '');
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                  */
/* -------------------------------------------------------------------------- */

test('a saved position comes back for any spelling of the same url', async () => {
  await saveScrollPosition('https://example.com/a.md', position('intro', 0.25));

  const restored = await loadScrollPosition('https://example.com/a.md#other');
  assert.deepEqual(restored, { anchor: 'intro', sectionRatio: 0, ratio: 0.25 });
});

test('an unknown document remembers nothing', async () => {
  assert.equal(await loadScrollPosition('https://example.com/never.md'), null);
});

test('positions live under their own key, apart from settings', async () => {
  // Clearing scroll memory must never be able to take settings with it.
  data.settings = { theme: 'dark' };
  await saveScrollPosition('https://example.com/a.md', position());
  await clearAllScrollPositions();

  assert.deepEqual(data.settings, { theme: 'dark' });
  assert.ok(!(DOCUMENT_STATE_KEY in data), 'cleared state should remove the key');
});

test('a single document can be forgotten without touching the rest', async () => {
  await saveScrollPosition('https://example.com/a.md', position());
  await saveScrollPosition('https://example.com/b.md', position());
  await clearScrollPosition('https://example.com/a.md');

  assert.equal(await loadScrollPosition('https://example.com/a.md'), null);
  assert.ok(await loadScrollPosition('https://example.com/b.md'));
});

/* -------------------------------------------------------------------------- */
/* Eviction                                                                    */
/* -------------------------------------------------------------------------- */

test('storage stops growing at the limit', async () => {
  for (let i = 0; i < DOCUMENT_STATE_LIMIT + 25; i += 1) {
    await saveScrollPosition(`https://example.com/${i}.md`, position());
  }

  assert.equal(await countRememberedDocuments(), DOCUMENT_STATE_LIMIT);
  // The first 25 written are the 25 least recently used, so they are the ones
  // that went.
  assert.equal(await loadScrollPosition('https://example.com/0.md'), null);
  assert.equal(await loadScrollPosition('https://example.com/24.md'), null);
  assert.ok(await loadScrollPosition('https://example.com/25.md'));
});

test('eviction is least-recently-used, not insertion order', async () => {
  // Reading counts as use. A reference document reopened daily but never
  // scrolled would otherwise be evicted ahead of a file touched once, months
  // ago — which is exactly the entry a reader would notice losing.
  for (let i = 0; i < DOCUMENT_STATE_LIMIT; i += 1) {
    await saveScrollPosition(`https://example.com/${i}.md`, position());
  }

  await loadScrollPosition('https://example.com/0.md');
  await saveScrollPosition('https://example.com/new.md', position());

  assert.ok(
    await loadScrollPosition('https://example.com/0.md'),
    'the recently read entry should have survived',
  );
  assert.equal(
    await loadScrollPosition('https://example.com/1.md'),
    null,
    'the genuinely oldest entry should have been evicted',
  );
});

test('writes inside one millisecond still evict in order', () => {
  // Date.now() has millisecond resolution and a loop like the one above runs
  // well inside one, so ties in the recency stamp are the normal case, not an
  // edge case. A tie makes the sort arbitrary.
  const states: Record<string, { position: ScrollPosition; usedAt: number }> = {};
  for (let i = 0; i < 5; i += 1) states[`k${i}`] = { position: position(), usedAt: 1 };
  states.k4.usedAt = 2;

  const kept = Object.keys(pruneToLimit(states, 2));
  assert.equal(kept.length, 2);
  assert.ok(kept.includes('k4'));
});

test('a map already within the limit is untouched', () => {
  const states = { a: { position: position(), usedAt: 1 } };
  assert.deepEqual(Object.keys(pruneToLimit(states, 10)), ['a']);
});

/* -------------------------------------------------------------------------- */
/* Degradation                                                                 */
/* -------------------------------------------------------------------------- */

test('a storage failure degrades instead of throwing', async () => {
  // This runs in the renderer, which has already replaced the page content. An
  // unhandled rejection here would be a scroll handler throwing on every frame.
  brokenStorage();

  await assert.doesNotReject(() =>
    saveScrollPosition('https://example.com/a.md', position()),
  );
  assert.equal(await loadScrollPosition('https://example.com/a.md'), null);
  await assert.doesNotReject(clearAllScrollPositions);
  await assert.doesNotReject(() => clearScrollPosition('https://example.com/a.md'));
  assert.equal(await countRememberedDocuments(), 0);
});

test('no chrome api at all is survivable', async () => {
  // Injected scripts can outlive their extension context; `chrome` then goes
  // from an object to a ReferenceError mid-session.
  setChrome(undefined);

  await assert.doesNotReject(() =>
    saveScrollPosition('https://example.com/a.md', position()),
  );
  assert.equal(await loadScrollPosition('https://example.com/a.md'), null);
});

test('corrupt entries are dropped, not propagated', async () => {
  // Storage outlives the code that wrote it. One malformed entry — from an
  // older version, or a half-finished write — must not lose the whole map.
  data[DOCUMENT_STATE_KEY] = {
    'https://example.com/good.md': { position: position('intro'), usedAt: 5 },
    'https://example.com/bad.md': { position: { anchor: 7 }, usedAt: 5 },
    'https://example.com/worse.md': 'nonsense',
  };

  assert.ok(await loadScrollPosition('https://example.com/good.md'));
  assert.equal(await loadScrollPosition('https://example.com/bad.md'), null);
  assert.equal(await countRememberedDocuments(), 1);
});

/* -------------------------------------------------------------------------- */
/* Position encoding                                                           */
/* -------------------------------------------------------------------------- */

const anchors: AnchorOffset[] = [
  { id: 'intro', top: 0 },
  { id: 'usage', top: 1000 },
  { id: 'api', top: 2000 },
];

test('a position is recorded against the heading above it', () => {
  const encoded = encodePosition(1500, 3000, anchors);
  assert.equal(encoded.anchor, 'usage');
  assert.equal(encoded.sectionRatio, 0.5);
  assert.equal(encoded.ratio, 0.5);
});

test('a position above the first heading has no anchor', () => {
  // A document can open with prose, or a badge block, before its first heading.
  const encoded = encodePosition(0, 3000, [{ id: 'intro', top: 400 }]);
  assert.equal(encoded.anchor, null);
  assert.equal(encoded.ratio, 0);
});

test('landing on a heading records that heading, not the one before', () => {
  // Sub-pixel scroll offsets are routine after an anchor jump; without the snap
  // tolerance, returning to `#usage` would restore to the end of `#intro`.
  assert.equal(encodePosition(998, 3000, anchors).anchor, 'usage');
  assert.equal(encodePosition(1002, 3000, anchors).anchor, 'usage');
});

test('a reflow moves the restored position with the content', () => {
  // The whole reason positions are not stored as pixels: bumping the font size
  // makes every offset in the document wrong. Here the document lays out twice
  // as tall, and the reader must come back to the same *place in the text*,
  // not to the same pixel.
  const encoded = encodePosition(1500, 3000, anchors);
  const reflowed: AnchorOffset[] = [
    { id: 'intro', top: 0 },
    { id: 'usage', top: 2000 },
    { id: 'api', top: 4000 },
  ];

  assert.equal(decodePosition(encoded, 6000, reflowed), 3000);
});

test('an unchanged layout round-trips exactly', () => {
  for (const y of [0, 250, 1000, 2500]) {
    const encoded = encodePosition(y, 3000, anchors);
    assert.equal(decodePosition(encoded, 3000, anchors), y);
  }
});

test('a vanished heading falls back to the height fraction', () => {
  // The file was edited and the heading renamed. Approximately as far through
  // as before beats the top of the document.
  const encoded = encodePosition(1500, 3000, anchors);
  const renamed: AnchorOffset[] = [
    { id: 'intro', top: 0 },
    { id: 'how-to-use', top: 1000 },
  ];

  assert.equal(decodePosition(encoded, 3000, renamed), 1500);
});

test('a document with no headings still restores proportionally', () => {
  const encoded = encodePosition(600, 2400, []);
  assert.equal(encoded.anchor, null);
  assert.equal(decodePosition(encoded, 4800, []), 1200);
});

test('degenerate measurements encode as the top of the document', () => {
  // A zero-height document is what an unmounted or hidden viewer measures as;
  // NaN from a division by it would be persisted and never recover.
  const encoded = encodePosition(0, 0, []);
  assert.equal(encoded.ratio, 0);
  assert.equal(decodePosition(encoded, 0, []), 0);
});
