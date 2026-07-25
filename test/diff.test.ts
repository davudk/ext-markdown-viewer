/**
 * Document comparison.
 *
 * jsdiff is not installed in this test — it is an on-demand add-on and the
 * module under test deliberately does not import it. A fake engine stands in,
 * which is not a compromise but the point: everything worth asserting here is
 * what `lib/diff.ts` *does* with a diff, and a hand-written change list makes
 * the awkward cases (a block with unequal sides, a file with no final newline,
 * two changes with three lines between them) expressible in one literal.
 *
 * The failure this file mostly exists to catch is a row list that lies about
 * line numbers. A diff that draws the right text against the wrong number is
 * worse than no diff at all, because it is believed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import {
  DIFF_BRIDGE_KEY,
  DIFF_MAX_LINES,
  DIFF_READY_EVENT,
} from '../lib/config.ts';
import {
  blockRows,
  changeBlocks,
  collapseContext,
  compareRendered,
  compareSource,
  countLines,
  diffStats,
  documentBlocks,
  highlightMarkdown,
  pairRows,
  sourceRows,
  splitLines,
  waitForEngine,
  DiffTooLargeError,
  type DiffChange,
  type DiffEngine,
  type DiffRow,
} from '../lib/diff.ts';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A change list written the way jsdiff would hand one back. */
function same(value: string): DiffChange<string> {
  return { value };
}
function gone(value: string): DiffChange<string> {
  return { value, removed: true };
}
function fresh(value: string): DiffChange<string> {
  return { value, added: true };
}

/** Compact rendering of a row list, so an assertion reads like a diff. */
function shape(rows: DiffRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'gap') return `… ${row.hidden}`;
    const left = row.before ? `${row.before.number}:${row.before.text}` : '-';
    const right = row.after ? `${row.after.number}:${row.after.text}` : '-';
    return `${row.kind} ${left} | ${right}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Splitting                                                                   */
/* -------------------------------------------------------------------------- */

test('a trailing newline does not invent a final empty line', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.equal(countLines('a\nb\n'), 2);
});

test('a file with no final newline keeps its last line', () => {
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
});

test('an empty run is no lines, not one empty one', () => {
  assert.deepEqual(splitLines(''), []);
});

test('CRLF is normalized away rather than becoming trailing carriage returns', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

/* -------------------------------------------------------------------------- */
/* Row building                                                                */
/* -------------------------------------------------------------------------- */

test('each side is numbered against its own file', () => {
  const rows = sourceRows([
    same('one\ntwo\n'),
    gone('three\n'),
    fresh('THREE\nthree and a half\n'),
    same('four\n'),
  ]);

  assert.deepEqual(shape(rows), [
    'context 1:one | 1:one',
    'context 2:two | 2:two',
    'removed 3:three | -',
    'added - | 3:THREE',
    'added - | 4:three and a half',
    // The fourth line of the old file is the fifth of the new one. Getting this
    // wrong is the bug the whole file is here for.
    'context 4:four | 5:four',
  ]);
});

test('a deletion and the addition that replaces it are one change, not two', () => {
  const rows = sourceRows([same('a\n'), gone('b\n'), fresh('B\n'), same('c\n')]);
  assert.deepEqual(
    rows.map((row) => row.block),
    [-1, 0, 0, -1],
  );
  assert.equal(changeBlocks(rows).length, 1);
});

test('changes separated by context are separate blocks', () => {
  const rows = sourceRows([
    gone('a\n'),
    same('b\n'),
    fresh('c\n'),
  ]);

  const blocks = changeBlocks(rows);
  assert.deepEqual(
    blocks.map((block) => [block.index, block.row, block.added, block.removed]),
    [
      [0, 0, 0, 1],
      [1, 2, 1, 0],
    ],
  );
});

/* -------------------------------------------------------------------------- */
/* Pairing                                                                     */
/* -------------------------------------------------------------------------- */

test('a split row pairs a removal with the addition opposite it', () => {
  const rows = pairRows(
    sourceRows([same('a\n'), gone('b\n'), fresh('B\n'), same('c\n')]),
  );

  assert.deepEqual(shape(rows), [
    'context 1:a | 1:a',
    'changed 2:b | 2:B',
    'context 3:c | 3:c',
  ]);
});

test('an unequal block runs out on one side rather than misaligning', () => {
  const rows = pairRows(
    sourceRows([gone('a\nb\nc\n'), fresh('A\n'), same('d\n')]),
  );

  assert.deepEqual(shape(rows), [
    'changed 1:a | 1:A',
    'removed 2:b | -',
    'removed 3:c | -',
    'context 4:d | 2:d',
  ]);
});

test('pairing preserves the block a row belongs to', () => {
  const rows = pairRows(sourceRows([gone('a\n'), fresh('A\n')]));
  assert.deepEqual(
    rows.map((row) => row.block),
    [0],
  );
  assert.equal(changeBlocks(rows).length, 1);
});

test('two adjacent blocks are not merged by pairing', () => {
  const rows = pairRows(
    sourceRows([gone('a\n'), same('b\n'), gone('c\n'), fresh('C\n')]),
  );

  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.block}`),
    ['removed:0', 'context:-1', 'changed:1'],
  );
});

/* -------------------------------------------------------------------------- */
/* Folding                                                                     */
/* -------------------------------------------------------------------------- */

const LONG = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join('\n');

test('a long run of context between two changes folds to a single gap', () => {
  const rows = sourceRows([gone('top\n'), same(`${LONG}\n`), fresh('end\n')]);
  const folded = collapseContext(rows);

  const gaps = folded.filter((row) => row.kind === 'gap');
  assert.equal(gaps.length, 1);
  // Three lines kept either side of the run, so 30 - 6 disappear.
  assert.equal(gaps[0].hidden, 24);
  assert.equal(folded.length, rows.length - 24 + 1);
});

test('context at the very top and bottom keeps nothing, having nothing to orient against', () => {
  const rows = sourceRows([same(`${LONG}\n`), gone('x\n'), same(`${LONG}\n`)]);
  const folded = collapseContext(rows);

  assert.equal(folded[0].kind, 'gap');
  assert.equal(folded[0].hidden, 27);
  assert.equal(folded[folded.length - 1].kind, 'gap');
});

test('a short run is left alone — folding it would not be a saving', () => {
  const rows = sourceRows([gone('a\n'), same('b\nc\nd\n'), fresh('e\n')]);
  assert.equal(collapseContext(rows).some((row) => row.kind === 'gap'), false);
});

test('an expanded gap comes back in full and stays expandable', () => {
  const rows = sourceRows([gone('top\n'), same(`${LONG}\n`), fresh('end\n')]);
  const folded = collapseContext(rows);
  const gap = folded.find((row) => row.kind === 'gap');

  assert.ok(gap?.at !== undefined);
  const opened = collapseContext(rows, new Set([gap.at]));
  assert.equal(opened.some((row) => row.kind === 'gap'), false);
  assert.equal(opened.length, rows.length);
});

test('folding never removes a change row, so the counts survive it', () => {
  const rows = sourceRows([gone('top\n'), same(`${LONG}\n`), fresh('end\n')]);
  assert.deepEqual(diffStats(collapseContext(rows)), diffStats(rows));
});

/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

test('a paired row counts on both sides', () => {
  const unified = sourceRows([gone('a\n'), fresh('A\n')]);
  assert.deepEqual(diffStats(unified), { added: 1, removed: 1 });
  assert.deepEqual(diffStats(pairRows(unified)), { added: 1, removed: 1 });
});

/* -------------------------------------------------------------------------- */
/* The two comparisons                                                         */
/* -------------------------------------------------------------------------- */

/** Stands in for the add-on. Line diffing is faked by whole-file equality. */
const engine: DiffEngine = {
  lines: (before, after) =>
    before === after
      ? [{ value: before }]
      : [{ value: before, removed: true }, { value: after, added: true }],
  // Positional rather than clever: enough to produce the interleaved shape a
  // real `diffArrays` emits, which is what the pairing has to cope with.
  blocks: (before, after) => {
    const changes: DiffChange<string[]>[] = [];

    for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
      if (before[at] !== undefined && before[at] === after[at]) {
        changes.push({ value: [before[at]] });
        continue;
      }
      if (before[at] !== undefined) changes.push({ value: [before[at]], removed: true });
      if (after[at] !== undefined) changes.push({ value: [after[at]], added: true });
    }

    return changes;
  },
};

test('an identical pair produces no changes at all', () => {
  const result = compareSource('a\nb\n', 'a\nb\n', engine);
  assert.deepEqual(result.stats, { added: 0, removed: 0 });
  assert.equal(changeBlocks(result.split).length, 0);
});

test('a comparison beyond the line limit refuses instead of trying', () => {
  const huge = `${'x\n'.repeat(DIFF_MAX_LINES + 1)}`;
  assert.throws(() => compareSource(huge, 'x\n', engine), DiffTooLargeError);
});

test('the limit is measured against the larger of the two files', () => {
  const huge = `${'x\n'.repeat(DIFF_MAX_LINES + 1)}`;
  // The short side first, so a check that only looked at `before` would pass.
  assert.throws(() => compareSource('x\n', huge, engine), DiffTooLargeError);
});

test('a rendered comparison pairs changed blocks side by side', () => {
  const result = compareRendered(
    ['<p>one</p>', '<p>two</p>'],
    ['<p>ONE</p>', '<p>two</p>'],
    engine,
  );

  assert.deepEqual(
    result.rows.map((row) => [row.kind, row.before?.text, row.after?.text]),
    [
      ['changed', '<p>one</p>', '<p>ONE</p>'],
      ['context', '<p>two</p>', '<p>two</p>'],
    ],
  );
  assert.deepEqual(result.stats, { added: 1, removed: 1 });
});

test('block rows number blocks, not lines', () => {
  const rows = blockRows([{ value: ['<h1>a</h1>', '<p>b</p>'] }]);
  assert.deepEqual(
    rows.map((row) => row.before?.number),
    [1, 2],
  );
});

test('documentBlocks takes the top-level children and nothing below them', () => {
  const dom = new JSDOM(
    '<body><h1 id="t">T</h1><p>one <em>two</em></p><ul><li>x</li></ul></body>',
  );

  assert.deepEqual(documentBlocks(dom.window.document.body), [
    '<h1 id="t">T</h1>',
    '<p>one <em>two</em></p>',
    '<ul><li>x</li></ul>',
  ]);
});

/* -------------------------------------------------------------------------- */
/* Highlighting                                                                */
/* -------------------------------------------------------------------------- */

test('a heading is highlighted as markdown rather than escaped wholesale', () => {
  const html = highlightMarkdown('## Heading');
  assert.match(html, /<span/);
  assert.match(html, /Heading/);
});

test('markup in the source is escaped, never emitted', () => {
  const html = highlightMarkdown('<img src=x onerror="alert(1)">');

  // hljs tokenizes the tag, so the angle brackets are escaped and the parts in
  // between are wrapped — what must never appear is a live element or a live
  // attribute, which is what these two assert.
  assert.equal(/<(?!\/?span\b)/.test(html), false);
  assert.equal(/onerror\s*=\s*["']/.test(html), false);
  assert.match(html, /&lt;/);
});

test('an empty line highlights to an empty string, not to a stray span', () => {
  assert.equal(highlightMarkdown(''), '');
});

/* -------------------------------------------------------------------------- */
/* The bridge                                                                  */
/* -------------------------------------------------------------------------- */

test('an engine already published is returned without waiting', async () => {
  const world = globalThis as Record<string, unknown>;
  world[DIFF_BRIDGE_KEY] = engine;

  try {
    assert.equal(await waitForEngine(0), engine);
  } finally {
    delete world[DIFF_BRIDGE_KEY];
  }
});

test('an add-on that publishes nothing fails visibly rather than hanging', async () => {
  await assert.rejects(waitForEngine(5), /published nothing/);
});

test('the ready event resolves a waiter that arrived first', async () => {
  const dom = new JSDOM('');
  const world = globalThis as Record<string, unknown>;
  const addListener = dom.window.addEventListener.bind(dom.window);
  const removeListener = dom.window.removeEventListener.bind(dom.window);

  // `waitForEngine` reads `globalThis`, which under bare node is not an event
  // target at all; borrowing jsdom's is what makes the subscription testable.
  const original = {
    add: globalThis.addEventListener,
    remove: globalThis.removeEventListener,
  };
  Object.assign(globalThis, {
    addEventListener: addListener,
    removeEventListener: removeListener,
  });

  try {
    const pending = waitForEngine(1000);
    world[DIFF_BRIDGE_KEY] = engine;
    dom.window.dispatchEvent(new dom.window.Event(DIFF_READY_EVENT));

    assert.equal(await pending, engine);
  } finally {
    delete world[DIFF_BRIDGE_KEY];
    Object.assign(globalThis, {
      addEventListener: original.add,
      removeEventListener: original.remove,
    });
  }
});
