/**
 * Click a column header to sort the table under it.
 *
 * Three states per column — ascending, descending, and back to the order the
 * document was written in. The third one is the reason this is written the way
 * it is: "original order" cannot be recovered by sorting on a row index,
 * because a row index is only correct until the first sort moves it. So the
 * pass captures the live `<tr>` nodes once, in document order, and the third
 * state re-appends *that* array. It is the same trick `code-copy` uses to
 * unwrap exactly the blocks it wrapped rather than querying for them later.
 *
 * Types are inferred per column from every cell in it, never from one sample:
 * a column whose cells are `9`, `10`, `100` is a number column, and `10` must
 * not sort before `9` because a string comparison said so. One dissenting cell
 * demotes the column to text, which is the honest answer for a column mixing
 * `1,200` with `n/a` — sorting it as numbers would have to invent an order for
 * the words.
 *
 * Tables containing `colspan` or `rowspan` are refused outright, visibly: they
 * get no affordance at all. `markdown-it-multimd-table` emits both, and moving
 * a row out from under a cell that spans into it does not produce a
 * differently-ordered table, it produces a corrupt one. A control that would
 * damage the document is worse than no control.
 *
 * Split from `index.ts` so the bare test runner can reach it: this plugin has
 * no JSX, so the seam is a plain re-export and the stylesheet import is what
 * lives on the other side of it.
 */

import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';

export const SORTABLE_TABLES_PLUGIN_ID = 'sortable-tables';

/** The control, and the marker its stylesheet draws the indicator from. */
const CONTROL = 'mdv-sort';
const STATE = 'data-mdv-sort';

/** How a column is currently ordered. `null` is the document's own order. */
export type SortDirection = 'ascending' | 'descending';

/** What a column's cells were found to hold. */
export type ColumnType = 'number' | 'date' | 'string';

/**
 * Two rows are the minimum for sorting to mean anything. A single-row table
 * offering a control that visibly does nothing is the same failure as an
 * unsortable one that looks sortable.
 */
const MIN_ROWS = 2;

const ICON = [
  `<svg class="${CONTROL}-icon" viewBox="0 0 16 16" width="11" height="11"`,
  'fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"',
  'stroke-linejoin="round" aria-hidden="true" focusable="false">',
].join(' ');

/** One glyph per state; the stylesheet shows exactly the one that applies. */
const ICON_NONE = `${ICON}<path class="${CONTROL}-up" d="M8 10.5 4.5 6.5h7z"/></svg>`;
const ICON_ASC = `${ICON}<path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5"/></svg>`;
const ICON_DESC = `${ICON}<path d="M8 3.5V12M4.5 8.5 8 12l3.5-3.5"/></svg>`;

/* -------------------------------------------------------------------------- */
/* Value parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A number, or `null` for anything that is not one.
 *
 * Thousands separators, a leading currency mark and a trailing percent are all
 * stripped, because a column of `$1,200` is a column of numbers to everyone
 * except a string comparison. Nothing looser: `12 apples` stays text, or the
 * inference below would quietly claim a prose column.
 */
export function parseNumber(text: string): number | null {
  const cleaned = text
    .replace(/[\s\u00a0,]/g, '')
    .replace(/^[-+]?[$£€¥]/, (match) => (match.length > 1 ? match[0] : ''))
    .replace(/%$/, '');

  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Month names, so `5 Jan 2024` and `January 5, 2024` are both dates. */
const MONTH_NAME =
  '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

const DATE_PATTERNS = [
  // ISO, with or without a time. The only unambiguous numeric form there is.
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[-+]\d{2}:?\d{2})?)?$/,
  /^\d{4}\/\d{2}\/\d{2}$/,
  // US order. Ambiguous against d/m/y, and picked because it is what an
  // English-language document overwhelmingly means — but only ever reached for
  // a column where *every* cell is a date, so a mis-read is a mis-ordering
  // within one column rather than a wrong type for the whole of it.
  /^\d{1,2}\/\d{1,2}\/\d{4}$/,
  new RegExp(`^${MONTH_NAME}\\.?\\s+\\d{1,2},?\\s+\\d{4}$`, 'i'),
  new RegExp(`^\\d{1,2}\\s+${MONTH_NAME}\\.?,?\\s+\\d{4}$`, 'i'),
];

/**
 * A timestamp, or `null`.
 *
 * `Date.parse` alone is not the test: it accepts `2024`, every bare integer in
 * some engines, and a good deal of prose. The patterns are the gate and
 * `Date.parse` only turns what got through into a number — so a numeric column
 * can never be mistaken for a date column.
 */
export function parseDate(text: string): number | null {
  if (!DATE_PATTERNS.some((pattern) => pattern.test(text))) return null;

  // `2024-01-05` is parsed as UTC and `2024/01/05` as local; normalizing the
  // separator keeps a column of one form from drifting against the other.
  const value = Date.parse(text.replace(/^(\d{4})\/(\d{2})\/(\d{2})$/, '$1-$2-$3'));
  return Number.isNaN(value) ? null : value;
}

/* -------------------------------------------------------------------------- */
/* Columns                                                                     */
/* -------------------------------------------------------------------------- */

/** A cell's text, or `''` for a row too short to have that column. */
function cellText(row: HTMLTableRowElement, index: number): string {
  return row.cells[index]?.textContent?.trim() ?? '';
}

/**
 * What a whole column holds.
 *
 * Empty cells abstain rather than vote: a ragged column of numbers with two
 * gaps is still a column of numbers, and the gaps are ordered separately below.
 * Everything else must agree — one word in a column of numbers makes it text,
 * because there is no defensible place to put the word among the numbers.
 */
export function inferColumnType(values: readonly string[]): ColumnType {
  const present = values.filter((value) => value !== '');
  if (present.length === 0) return 'string';

  if (present.every((value) => parseNumber(value) !== null)) return 'number';
  if (present.every((value) => parseDate(value) !== null)) return 'date';
  return 'string';
}

interface Keyed {
  row: HTMLTableRowElement;
  text: string;
  value: number;
  /** Missing cells sort last in both directions rather than flipping ends. */
  empty: boolean;
}

/**
 * The rows of one column, ordered.
 *
 * Stable by construction: `Array.prototype.sort` is stable, and the input is
 * document order, so rows that compare equal keep the order they were written
 * in — which is what makes a second column sort read as a secondary key.
 */
export function sortRows(
  rows: readonly HTMLTableRowElement[],
  index: number,
  type: ColumnType,
  direction: SortDirection,
): HTMLTableRowElement[] {
  const keyed: Keyed[] = rows.map((row) => {
    const text = cellText(row, index);
    const parsed = type === 'number' ? parseNumber(text) : type === 'date' ? parseDate(text) : null;

    return {
      row,
      text,
      // An unparseable cell in a typed column is treated as missing, which is
      // the only ordering that does not invent a number for it.
      value: parsed ?? 0,
      empty: type === 'string' ? text === '' : parsed === null,
    };
  });

  const sign = direction === 'ascending' ? 1 : -1;

  return keyed
    .sort((a, b) => {
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      if (a.empty) return 0;

      if (type === 'string') {
        return sign * a.text.localeCompare(b.text, undefined, { sensitivity: 'base' });
      }
      return sign * (a.value - b.value);
    })
    .map((entry) => entry.row);
}

/* -------------------------------------------------------------------------- */
/* Which tables can be sorted at all                                           */
/* -------------------------------------------------------------------------- */

function spans(table: HTMLTableElement): boolean {
  for (const cell of Array.from(table.querySelectorAll('[colspan], [rowspan]'))) {
    for (const name of ['colspan', 'rowspan']) {
      const raw = cell.getAttribute(name);
      // `colspan="1"` is what the attribute means when it is absent, so it is
      // not a span and refusing on it would disable ordinary tables that
      // happened to spell it out.
      if (raw !== null && Number(raw) !== 1) return true;
    }
  }
  return false;
}

/**
 * The head row a control could be attached to, or `null`.
 *
 * One `<tbody>` only. Several are a structure this cannot reorder without
 * choosing which body a row belongs in after the sort — and a table with more
 * than one is a multimd table, which is refused above anyway.
 */
function sortableParts(
  table: HTMLTableElement,
): { headers: HTMLTableCellElement[]; tbody: HTMLTableSectionElement; rows: HTMLTableRowElement[] } | null {
  if (spans(table)) return null;
  if (table.tBodies.length !== 1) return null;

  const headRow = table.tHead?.rows[0];
  if (!headRow) return null;

  const headers = Array.from(headRow.cells).filter(
    (cell): cell is HTMLTableCellElement => cell.tagName === 'TH',
  );
  if (headers.length === 0) return null;

  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows);
  if (rows.length < MIN_ROWS) return null;

  return { headers, tbody, rows };
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

interface TableState {
  tbody: HTMLTableSectionElement;
  headers: HTMLTableCellElement[];
  /** The live nodes, in the order the document had them. Never re-derived. */
  original: HTMLTableRowElement[];
  types: ColumnType[];
  /** Index into `headers`, or -1 for "the document's own order". */
  active: number;
  direction: SortDirection | null;
  /** Held in the document's own order while an export is reading the body. */
  parked: boolean;
}

/** One document's worth of sorting, as the plugin holds it. */
interface Pass {
  teardown: Teardown;
  /** Put every table back in document order without forgetting the sort. */
  park(): void;
  unpark(): void;
}

export function createSortableTablesPlugin(): Plugin {
  return {
    id: SORTABLE_TABLES_PLUGIN_ID,
    name: 'Sortable tables',
    description: 'Click a column header to sort the table by it.',
    apiVersion: PLUGIN_API_VERSION,
    // No setting of its own: whether tables sort is this plugin's enabled state
    // and nothing else, which is one concept rather than two that can disagree.
    enabledByDefault: true,

    setup(ctx) {
      /** The pass over the document currently on screen, if any. */
      let live: Pass | null = null;

      const stop = ctx.document.enhance((body) => {
        // The raw view is one `<pre>` holding the source. There is no table in
        // it, and marking up the source would be an edit.
        if (ctx.document.isRaw) return;

        const pass = attach(body);
        live = pass;

        return () => {
          // A new body drops this pass; the next one installs its own.
          if (live === pass) live = null;
          pass.teardown();
        };
      });

      const stopExport = watchExport(ctx, () => live);

      return () => {
        stopExport();
        stop();
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Keeping the export the document                                             */
/* -------------------------------------------------------------------------- */

/**
 * A sort is a view, and an export is the document.
 *
 * `lib/export.ts` does not take a copy of anything: `exportDocument` is handed
 * the *live* `.mdv-body` and clones it itself, some way into an async run. So a
 * reordered `<tbody>` would be written into the file — the reader's current
 * view frozen into a document they will open somewhere else, with no control
 * left in it to undo the sort. Stripping the control is not enough, because
 * `CHROME_SELECTOR` removes buttons and `[data-mdv-chrome]`, and row order is
 * neither.
 *
 * The fix goes through the documented seam rather than around it. The `export`
 * capability publishes its status as a store, and it moves to `busy`
 * synchronously — before the add-on is injected and long before the body is
 * cloned. That is the moment to put the rows back, and settling is the moment
 * to restore the reader's sort. No import of the export plugin, and a build
 * with export disabled simply never binds: absence is a normal state.
 */
function watchExport(
  ctx: Parameters<NonNullable<Plugin['setup']>>[0],
  current: () => Pass | null,
): Teardown {
  let stopStatus: Teardown | null = null;

  const bind = () => {
    stopStatus?.();
    stopStatus = null;

    const exporter = ctx.capabilities.use('export');
    if (!exporter) return;

    let parked = false;
    stopStatus = exporter.status.subscribe(() => {
      const busy = exporter.status.get().state === 'busy';
      if (busy === parked) return;

      parked = busy;
      if (busy) current()?.park();
      else current()?.unpark();
    });
  };

  bind();
  // The capability appears when the export plugin is enabled and disappears
  // when it is not; rebinding is what keeps this correct across a toggle.
  const stopChange = ctx.capabilities.onChange(bind);

  return () => {
    stopChange();
    stopStatus?.();
  };
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One document's worth of sorting, and its exact inverse.
 *
 * Nothing is written onto the table itself: the control is a `<button>` inside
 * the header cell, and `aria-sort` is set only on the column that is actually
 * sorted. `lib/export.ts` strips `button` and `[data-mdv-chrome]` before it
 * writes a file, so the control never reaches an export — and a column in its
 * third state leaves no attribute behind for one to carry.
 */
function attach(body: HTMLElement): Pass {
  const states = new Map<HTMLTableElement, TableState>();

  for (const table of Array.from(body.querySelectorAll('table'))) {
    const parts = sortableParts(table);
    // Refused, and visibly so: no button, no cursor, no `aria-sort`. A reader
    // cannot tell a table that will not sort from one that silently failed to.
    if (!parts) continue;

    const { headers, tbody, rows } = parts;

    states.set(table, {
      tbody,
      headers,
      original: rows,
      types: headers.map((header) =>
        inferColumnType(rows.map((row) => cellText(row, header.cellIndex))),
      ),
      active: -1,
      direction: null,
      parked: false,
    });

    for (const header of headers) header.append(control(header));
  }

  const setParked = (parked: boolean) => {
    for (const state of states.values()) {
      state.parked = parked;
      render(state);
    }
  };

  const noop = () => {};
  if (states.size === 0) return { teardown: noop, park: noop, unpark: noop };

  /**
   * One listener for every header in the document rather than one per header.
   * Per-control listeners would have to be attached — and detached — each time
   * the body is replaced, on nodes React is not tracking.
   *
   * It lives on the body, so it unbinds with the pass: a document-level
   * listener would outlive the document it was registered for.
   *
   * The control is a real `<button>`, so Enter and Space arrive here as clicks
   * already and there is no key handling to write. A click anywhere else in the
   * header cell lands here too, which is what "click a column header" means.
   */
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const origin = event.target;
    if (!(origin instanceof Element)) return;

    const header = origin.closest('th');
    const table = header?.closest('table');
    if (!header || !table) return;

    const state = states.get(table as HTMLTableElement);
    if (!state) return;

    const index = state.headers.indexOf(header as HTMLTableCellElement);
    if (index < 0) return;

    cycle(state, index);
    render(state);
  };

  body.addEventListener('click', onClick);

  const teardown = () => {
    body.removeEventListener('click', onClick);

    for (const state of states.values()) {
      // The captured nodes, in the captured order — not a re-sort by a stored
      // index, which the first sort would already have invalidated.
      state.active = -1;
      state.direction = null;
      render(state);

      for (const header of state.headers) {
        header.removeAttribute('aria-sort');
        header.querySelector(`:scope > .${CONTROL}`)?.remove();
      }
    }

    states.clear();
  };

  return {
    teardown,
    park: () => setParked(true),
    unpark: () => setParked(false),
  };
}

function control(header: HTMLTableCellElement): HTMLButtonElement {
  const button = header.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = CONTROL;
  // Screen-only, and stripped from every export by `CHROME_SELECTOR`.
  button.setAttribute('data-mdv-chrome', '');
  button.setAttribute(STATE, 'none');
  // Named after its column: a page of identical "Sort" buttons is nothing a
  // screen reader can tell apart.
  const label = header.textContent?.trim();
  button.setAttribute('aria-label', label ? `Sort by ${label}` : 'Sort column');
  button.innerHTML =
    `<span class="${CONTROL}-face ${CONTROL}-face-none">${ICON_NONE}</span>` +
    `<span class="${CONTROL}-face ${CONTROL}-face-asc">${ICON_ASC}</span>` +
    `<span class="${CONTROL}-face ${CONTROL}-face-desc">${ICON_DESC}</span>`;

  return button;
}

/** ascending → descending → the document's own order → ascending. */
function cycle(state: TableState, index: number): void {
  if (state.active !== index) {
    state.active = index;
    state.direction = 'ascending';
    return;
  }

  if (state.direction === 'ascending') {
    state.direction = 'descending';
    return;
  }

  state.active = -1;
  state.direction = null;
}

function render(state: TableState): void {
  const { active, direction } = state;

  // While parked, the tables read as the document wrote them — rows, indicator
  // and `aria-sort` alike — without the sort itself being forgotten.
  const rows =
    state.parked || active < 0 || !direction
      ? state.original
      : sortRows(
          state.original,
          state.headers[active].cellIndex,
          state.types[active],
          direction,
        );

  // One insertion rather than one per row: appending a node that is already in
  // the tree moves it, so the fragment reorders the rows in a single mutation
  // and never detaches the table from the document in between.
  const fragment = state.tbody.ownerDocument.createDocumentFragment();
  for (const row of rows) fragment.append(row);
  state.tbody.append(fragment);

  state.headers.forEach((header, index) => {
    const sorted = !state.parked && index === active && direction !== null;
    const value = sorted ? direction : 'none';

    // Set only while the column is actually sorted. An absent `aria-sort` and
    // `aria-sort="none"` mean the same thing to assistive technology, and the
    // absent one leaves nothing for an export to carry.
    if (sorted) header.setAttribute('aria-sort', value);
    else header.removeAttribute('aria-sort');

    header.querySelector(`:scope > .${CONTROL}`)?.setAttribute(STATE, value);
  });
}
