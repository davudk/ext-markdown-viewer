/**
 * Sortable tables, through the real host.
 *
 * The three claims worth asserting are the three that implementations get
 * wrong: that `10` sorts after `9` in a numeric column, that the third click
 * returns the *document's* order rather than a re-sort by row index, and that
 * a table with a `colspan` is refused visibly rather than sorted into nonsense.
 *
 * The residue check is the strongest of them. Disabling has to leave the table
 * byte-for-byte what it was — rows back where the document had them, no button,
 * no `aria-sort` — because a reader who turns the feature off and finds their
 * table still shuffled has lost the document, not a feature.
 */
import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import type { AnyPlugin } from '../lib/plugins/types.ts';

let createSortableTablesPlugin: typeof import('../plugins/sortable-tables/plugin.ts').createSortableTablesPlugin;
let inferColumnType: typeof import('../plugins/sortable-tables/plugin.ts').inferColumnType;
let dom: JSDOM;

before(async () => {
  dom = new JSDOM('<div id="mdv-root"><main class="mdv-body"></main></div>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    'window',
    'document',
    'location',
    'Node',
    'HTMLElement',
    'Element',
    'MouseEvent',
    'MutationObserver',
  ]) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
  ({ createSortableTablesPlugin, inferColumnType } = await import(
    '../plugins/sortable-tables/plugin.ts'
  ));
});

function memoryStorage(): HostStorage {
  let value: unknown = null;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * One table carrying every case at once.
 *
 * `qty` is the `10` vs `9` column — sorted as text, `10` would come first and
 * the whole feature would be actively misleading. `when` is dates written two
 * ways a reader would call the same format. `who` is prose. `mixed` is a column
 * that cannot be typed: a number, a word, and a gap.
 */
const TABLE = `
  <table id="t">
    <thead>
      <tr><th>qty</th><th>when</th><th>who</th><th>mixed</th></tr>
    </thead>
    <tbody>
      <tr id="r1"><td>9</td><td>2024-03-01</td><td>delta</td><td>3</td></tr>
      <tr id="r2"><td>10</td><td>2024-01-15</td><td>Alpha</td><td>pending</td></tr>
      <tr id="r3"><td>-2</td><td>2024-11-30</td><td>charlie</td></tr>
      <tr id="r4"><td>1,200</td><td>2024-02-02</td><td>bravo</td><td>11</td></tr>
    </tbody>
  </table>
`;

/** A multimd-style table: a spanning cell makes any row move a corruption. */
const SPANNED = `
  <table id="s">
    <thead><tr><th colspan="2">Period</th><th>Value</th></tr></thead>
    <tbody>
      <tr id="s1"><td>Q1</td><td>Jan</td><td>2</td></tr>
      <tr id="s2"><td>Q2</td><td>Apr</td><td>1</td></tr>
    </tbody>
  </table>
`;

let host: PluginHost;
let shared: SharedDocument;
let body: HTMLElement;

function publish(isRaw = false) {
  shared.update({ body, source: '', html: '', headings: [], url: '', isRaw });
}

beforeEach(async () => {
  body = dom.window.document.querySelector('main.mdv-body')! as unknown as HTMLElement;
  body.innerHTML = `${TABLE}${SPANNED}`;

  shared = new SharedDocument();
  host = new PluginHost({
    plugins: [createSortableTablesPlugin()] as AnyPlugin[],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
});

/** The row ids in the order they currently stand in the DOM. */
const order = (id = 't') =>
  [...body.querySelectorAll(`#${id} tbody tr`)].map((row) => row.id);

function header(index: number): HTMLElement {
  return body.querySelectorAll('#t thead th')[index] as unknown as HTMLElement;
}

/** A click on the header cell, exactly as a reader's would arrive. */
function click(index: number) {
  header(index).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

/* -------------------------------------------------------------------------- */

test('a numeric column sorts by value, so 10 comes after 9', () => {
  publish();

  click(0);
  assert.deepEqual(order(), ['r3', 'r1', 'r2', 'r4'], '-2, 9, 10, 1,200');

  click(0);
  assert.deepEqual(order(), ['r4', 'r2', 'r1', 'r3']);
});

test('a date column sorts chronologically', () => {
  publish();

  click(1);
  assert.deepEqual(order(), ['r2', 'r4', 'r1', 'r3']);

  click(1);
  assert.deepEqual(order(), ['r3', 'r1', 'r4', 'r2']);
});

test('a string column sorts by text, ignoring case', () => {
  publish();

  click(2);
  assert.deepEqual(order(), ['r2', 'r4', 'r3', 'r1'], 'Alpha, bravo, charlie, delta');
});

test('a column that cannot be typed sorts as text, with gaps last', () => {
  publish();

  click(3);
  // `11` before `3` is the correct answer *for a text column*: the column holds
  // a word, so there is no numeric reading of it. The ragged row has no cell at
  // all and goes last in both directions.
  assert.deepEqual(order(), ['r4', 'r1', 'r2', 'r3']);

  click(3);
  assert.deepEqual(order(), ['r2', 'r1', 'r4', 'r3'], 'the gap flipped to the front');
});

test('inference reads the whole column, not one cell', () => {
  assert.equal(inferColumnType(['9', '10', '1,200', '-2']), 'number');
  assert.equal(inferColumnType(['9', '10', 'n/a']), 'string');
  // A gap abstains rather than demoting the column.
  assert.equal(inferColumnType(['9', '', '10']), 'number');
  assert.equal(inferColumnType(['2024-01-15', '2024-11-30']), 'date');
  // A bare year is a number, never a date — `Date.parse` would take it.
  assert.equal(inferColumnType(['2024', '1999']), 'number');
  assert.equal(inferColumnType(['', '']), 'string');
});

test('the third click restores the document order, not a re-sort', () => {
  publish();
  const original = order();

  click(0);
  assert.notDeepEqual(order(), original);
  click(0);
  click(0);

  assert.deepEqual(order(), original, 'the third state is the order the document had');
  assert.equal(header(0).hasAttribute('aria-sort'), false);
  assert.equal(
    body.querySelector('#t thead th .mdv-sort')?.getAttribute('data-mdv-sort'),
    'none',
  );
});

test('the indicator and aria-sort follow the state', () => {
  publish();

  const state = () => ({
    aria: header(0).getAttribute('aria-sort'),
    indicator: header(0).querySelector('.mdv-sort')?.getAttribute('data-mdv-sort'),
  });

  assert.deepEqual(state(), { aria: null, indicator: 'none' });
  click(0);
  assert.deepEqual(state(), { aria: 'ascending', indicator: 'ascending' });
  click(0);
  assert.deepEqual(state(), { aria: 'descending', indicator: 'descending' });
  click(0);
  assert.deepEqual(state(), { aria: null, indicator: 'none' });
});

test('sorting a second column releases the first', () => {
  publish();

  click(0);
  click(2);

  assert.equal(header(0).hasAttribute('aria-sort'), false);
  assert.equal(header(2).getAttribute('aria-sort'), 'ascending');
  assert.deepEqual(order(), ['r2', 'r4', 'r3', 'r1']);
});

test('the control is a real button, named after its column', () => {
  publish();

  const control = header(0).querySelector('.mdv-sort') as HTMLElement | null;
  assert.equal(control?.tagName, 'BUTTON');
  assert.equal(control?.getAttribute('type'), 'button');
  assert.equal(control?.getAttribute('aria-label'), 'Sort by qty');
  // Screen-only chrome: `lib/export.ts` strips this and every `button` before
  // it writes a file, so the control cannot reach an export.
  assert.equal(control?.getAttribute('data-mdv-chrome'), '');
});

test('a keyboard activation of the control sorts the column', () => {
  publish();

  // Enter and Space on a <button> arrive as a click; the delegated listener is
  // the only handler there is.
  const control = header(0).querySelector('.mdv-sort') as unknown as HTMLElement;
  control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(order(), ['r3', 'r1', 'r2', 'r4']);
  assert.equal(header(0).getAttribute('aria-sort'), 'ascending');
});

test('a table with a colspan is refused, and shows no affordance', () => {
  publish();

  assert.equal(
    body.querySelectorAll('#s .mdv-sort').length,
    0,
    'a spanning table was given a control',
  );

  // The `Value` column — the one a reader would most reasonably try to sort.
  const spannedHeader = body.querySelectorAll('#s thead th')[1] as unknown as HTMLElement;
  const before = order('s');
  assert.deepEqual(before, ['s1', 's2']);
  spannedHeader.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

  assert.deepEqual(order('s'), before, 'a refused table was reordered anyway');
  assert.equal(spannedHeader.hasAttribute('aria-sort'), false);
});

test('the raw view is left alone', () => {
  publish(true);
  assert.equal(body.querySelectorAll('.mdv-sort').length, 0);
});

test('disabling restores the order and leaves no residue', async () => {
  publish();
  const original = order();

  click(0);
  click(2);
  assert.notDeepEqual(order(), original);

  await host.setEnabled('sortable-tables', false);

  assert.deepEqual(order(), original, 'sorted rows were left behind');
  assert.equal(body.querySelectorAll('.mdv-sort').length, 0, 'a control survived');
  assert.equal(body.querySelectorAll('[aria-sort]').length, 0, 'a state attribute survived');
  assert.equal(body.innerHTML.includes('mdv-sort'), false);
});

test('repeated toggling accumulates nothing', async () => {
  publish();
  const original = order();

  for (let round = 0; round < 3; round += 1) {
    click(0);
    await host.setEnabled('sortable-tables', false);
    await host.setEnabled('sortable-tables', true);
  }

  assert.equal(
    body.querySelectorAll('#t thead th .mdv-sort').length,
    4,
    'one control per column, however many times it was toggled',
  );
  assert.deepEqual(order(), original);

  // And it still works after all that.
  click(0);
  assert.deepEqual(order(), ['r3', 'r1', 'r2', 'r4']);
});

test('the control never reaches an export', () => {
  publish();
  click(0);

  // What `CHROME_SELECTOR` does, asserted here rather than in `test/export.ts`
  // so the two files do not have to know about each other: it covers `button`
  // and `[data-mdv-chrome]`, and the control is both.
  const clone = body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-mdv-chrome], button').forEach((node) => node.remove());

  assert.equal(clone.querySelectorAll('.mdv-sort').length, 0);
  assert.equal(clone.querySelector('#t thead')?.innerHTML.includes('svg'), false);
});

/**
 * `lib/export.ts` is handed the *live* body and clones it itself, so a sorted
 * `<tbody>` would be written straight into the file. The export capability's
 * status store is the seam: it goes busy before the body is read, and this
 * plugin puts the rows back for the duration — through the capability, with no
 * import of the export plugin in either direction.
 */
test('an export sees the document order, and the sort comes back after', async () => {
  const { Store } = await import('../lib/plugins/registry.ts');
  const status = new Store<{ state: string }>({ state: 'idle' });

  const exportStub: AnyPlugin = {
    id: 'export',
    name: 'Export',
    description: 'stub',
    apiVersion: 1,
    enabledByDefault: true,
    setup(ctx) {
      return ctx.capabilities.provide(
        'export' as never,
        { formats: [], status, run: async () => {} } as never,
      );
    },
  };

  shared = new SharedDocument();
  host = new PluginHost({
    plugins: [exportStub, createSortableTablesPlugin()],
    storage: memoryStorage(),
    document: shared,
    logger: { warn: () => {}, error: () => {} },
  });
  await host.start();
  publish();

  const original = order();
  click(0);
  const sorted = order();
  assert.notDeepEqual(sorted, original);

  status.set({ state: 'busy' });
  assert.deepEqual(order(), original, 'the export would have written the sorted view');
  assert.equal(
    body.querySelectorAll('[aria-sort]').length,
    0,
    'a view-only attribute was left for the export to carry',
  );

  status.set({ state: 'idle' });
  assert.deepEqual(order(), sorted, 'the reader lost their sort to an export');
  assert.equal(header(0).getAttribute('aria-sort'), 'ascending');
});
