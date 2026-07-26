/**
 * Document comparison: the row model the diff view renders, and the bridge that
 * fetches jsdiff the first time anything asks for it.
 *
 * Nothing here imports jsdiff. That is the point — the library is injected on
 * demand (`ADDONS.diff` in config.ts), and if this module imported it the
 * renderer bundle would carry it on every page whether or not anyone ever
 * compares two files. So the shape is: the component asks `loadDiffEngine()`
 * for a `DiffEngine`, and everything below takes one as an argument.
 *
 * The row model is deliberately one type for both layouts and both modes. A
 * unified diff, a split diff and a rendered side-by-side are the same list of
 * paired lines drawn three ways, and keeping them one list is what lets change
 * navigation, the counter and the gap folding be written once.
 *
 * Everything except `loadDiffEngine` is pure and has no opinion about the DOM,
 * which is why the tests can drive it without one.
 */

// The ~40-language common bundle, not the full build. The diff highlights
// markdown and nothing else, and the full build carries ~190 grammars —
// importing it here put roughly 700kB back into the base bundle that the
// add-on split had just taken out.
import hljs from 'highlight.js/lib/common';

import {
  ADDON_READY_TIMEOUT_MS,
  DIFF_BRIDGE_KEY,
  DIFF_READY_EVENT,
} from './config.ts';
import { sendMessage, type AddonResult } from './messages.ts';

/* -------------------------------------------------------------------------- */
/* What the comparison will and will not do                                    */
/* -------------------------------------------------------------------------- */

/*
 * These four are read here and nowhere else. The bridge key and the ready event
 * above stay in `lib/config.ts` because they are a contract with
 * `entrypoints/diff-addon.ts`, which is a different bundle; a fold width is not.
 */

/** Unchanged lines kept either side of a change before the run is folded away. */
export const DIFF_CONTEXT_LINES = 3;

/**
 * A run shorter than this is left alone: folding it away would replace four
 * rows with one row plus a gap marker, which is not a saving.
 */
export const DIFF_MIN_COLLAPSE_LINES = 9;

/**
 * Lines per file above which the comparison refuses rather than tries.
 *
 * jsdiff is O(nd) and every row is real DOM; a pair of generated files can be
 * tens of thousands of lines each, and a comparison that locks the tab for a
 * minute is worse than one that says up front it will not run.
 */
export const DIFF_MAX_LINES = 20_000;

/** The markdown source is highlighted as markdown, so a diff still reads as one. */
export const DIFF_HIGHLIGHT_LANGUAGE = 'markdown';

/* -------------------------------------------------------------------------- */
/* The engine contract                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One run out of jsdiff.
 *
 * Declared structurally rather than imported from `diff`, so this module — and
 * therefore the renderer bundle — has no build-time dependency on the library
 * at all, not even a type-only one that a careless refactor could turn into a
 * value import.
 */
export interface DiffChange<T> {
  value: T;
  added?: boolean;
  removed?: boolean;
}

/** What `entrypoints/diff-addon.ts` publishes once it has loaded. */
export interface DiffEngine {
  /** Line-level diff of two texts. `diffLines`. */
  lines(before: string, after: string): DiffChange<string>[];
  /** Element-level diff of two sequences. `diffArrays`. */
  blocks(before: string[], after: string[]): DiffChange<string[]>[];
}

/* -------------------------------------------------------------------------- */
/* Loading it                                                                  */
/* -------------------------------------------------------------------------- */

function installed(): DiffEngine | null {
  const bridge = (globalThis as Record<string, unknown>)[DIFF_BRIDGE_KEY];
  return typeof bridge === 'object' && bridge !== null
    ? (bridge as DiffEngine)
    : null;
}

/**
 * Waits for the add-on to publish itself.
 *
 * An event rather than a poll, with one immediate re-check after subscribing:
 * the script normally finishes evaluating before `executeScript` resolves, so
 * the common path is the check at the top and no listener is ever attached.
 *
 * The timeout is the whole reason this is not a bare `await` on an event. A
 * bundle that throws on its way up injects "successfully" and then publishes
 * nothing, and the reader would otherwise sit in front of a spinner with no
 * indication that it is never going to finish.
 */
export function waitForEngine(
  timeoutMs = ADDON_READY_TIMEOUT_MS,
): Promise<DiffEngine> {
  const ready = installed();
  if (ready) return Promise.resolve(ready);

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const settle = () => {
      const engine = installed();
      if (!engine) return false;
      clearTimeout(timer);
      globalThis.removeEventListener?.(DIFF_READY_EVENT, settle);
      resolve(engine);
      return true;
    };

    timer = setTimeout(() => {
      globalThis.removeEventListener?.(DIFF_READY_EVENT, settle);
      reject(new Error('the comparison add-on loaded but published nothing'));
    }, timeoutMs);

    globalThis.addEventListener?.(DIFF_READY_EVENT, settle);
    // The gap between the check above and the subscription is real, if small.
    settle();
  });
}

/**
 * The one entry point for getting a working engine.
 *
 * Rejects rather than resolving to null on every failure path, so the caller has
 * a message to put on screen. Silence here would be the worst outcome: the
 * reader asked to compare two files and nothing would happen.
 */
export async function loadDiffEngine(): Promise<DiffEngine> {
  const ready = installed();
  if (ready) return ready;

  let result: AddonResult | undefined;
  try {
    result = await sendMessage<AddonResult>({ type: 'INJECT_ADDON', addon: 'diff' });
  } catch (error) {
    throw new Error(
      `the comparison add-on could not be requested — ${describe(error)}`,
    );
  }

  if (!result?.ok) {
    throw new Error(
      `the comparison add-on could not be loaded${result?.error ? ` — ${result.error}` : ''}`,
    );
  }

  return waitForEngine();
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* The row model                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `context` is unchanged on both sides; `added`/`removed` exist on one side
 * only; `changed` is a split-layout row that pairs a removal with an addition;
 * `gap` stands in for a folded run of context.
 */
export type RowKind = 'context' | 'added' | 'removed' | 'changed' | 'gap';

export interface DiffCell {
  /** 1-based position in its own file: a line number, or a block ordinal. */
  number: number;
  /**
   * The line's text. In a rendered comparison this is instead the block's
   * already-sanitized HTML, straight out of `renderMarkdown` — the only two
   * producers are `sourceRows` and `blockRows`, and each row knows which it is
   * from the comparison it came out of.
   */
  text: string;
}

export interface DiffRow {
  kind: RowKind;
  before: DiffCell | null;
  after: DiffCell | null;
  /** Which change block this row belongs to, or -1 for context and gaps. */
  block: number;
  /** On a `gap` row: how many context rows it replaced. */
  hidden?: number;
  /** On a `gap` row: index of the first row it replaced, and its identity. */
  at?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** A run of consecutive changed rows — one stop for next/previous navigation. */
export interface DiffBlock {
  /** 0-based position among the blocks. */
  index: number;
  /** Index into the row list this was computed from. */
  row: number;
  added: number;
  removed: number;
}

/**
 * jsdiff hands back each run as one string with the newlines still in it.
 *
 * The trailing empty element is dropped because `"a\nb\n".split('\n')` reports a
 * third, empty line that does not exist — but only when the run actually ended
 * in a newline, since a file with no final newline genuinely ends mid-line.
 */
export function splitLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Counts lines the way `splitLines` does, without building the array. */
export function countLines(text: string): number {
  return splitLines(text).length;
}

interface Item {
  text: string;
  added: boolean;
  removed: boolean;
}

/**
 * The single row builder. Both comparisons funnel through it, which is what
 * keeps block numbering, line numbering and pairing from having two subtly
 * different implementations.
 *
 * A block is a maximal run of consecutive non-context items, which is exactly
 * what a reader means by "the next change": a deletion immediately followed by
 * its replacement is one edit, not two.
 */
function buildRows(items: Item[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let before = 0;
  let after = 0;
  let block = -1;
  let inBlock = false;

  for (const item of items) {
    if (!item.added && !item.removed) {
      inBlock = false;
      before += 1;
      after += 1;
      rows.push({
        kind: 'context',
        before: { number: before, text: item.text },
        after: { number: after, text: item.text },
        block: -1,
      });
      continue;
    }

    if (!inBlock) {
      inBlock = true;
      block += 1;
    }

    if (item.removed) {
      before += 1;
      rows.push({
        kind: 'removed',
        before: { number: before, text: item.text },
        after: null,
        block,
      });
    } else {
      after += 1;
      rows.push({
        kind: 'added',
        before: null,
        after: { number: after, text: item.text },
        block,
      });
    }
  }

  return rows;
}

function toItems<T>(
  changes: DiffChange<T>[],
  explode: (value: T) => string[],
): Item[] {
  return changes.flatMap((change) =>
    explode(change.value).map((text) => ({
      text,
      added: change.added === true,
      removed: change.removed === true,
    })),
  );
}

/** Unified rows for a line-level comparison of two markdown sources. */
export function sourceRows(changes: DiffChange<string>[]): DiffRow[] {
  return buildRows(toItems(changes, splitLines));
}

/** Unified rows for a block-level comparison of two rendered documents. */
export function blockRows(changes: DiffChange<string[]>[]): DiffRow[] {
  return buildRows(toItems(changes, (value) => value));
}

/**
 * Unified rows, paired into split ones.
 *
 * Within a block the removals and the additions are zipped by position, which
 * is the convention every split diff uses: the reader is looking at "this line
 * became that line", and a run where the counts differ simply runs out on one
 * side and leaves the other half empty.
 */
export function pairRows(rows: DiffRow[]): DiffRow[] {
  const paired: DiffRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind !== 'removed' && row.kind !== 'added') {
      paired.push(row);
      continue;
    }

    // The whole block in one go, so the two halves can be matched up.
    const start = index;
    while (index + 1 < rows.length && rows[index + 1].block === row.block) {
      index += 1;
    }
    const run = rows.slice(start, index + 1);

    const removed = run.filter((entry) => entry.kind === 'removed');
    const added = run.filter((entry) => entry.kind === 'added');

    for (let at = 0; at < Math.max(removed.length, added.length); at += 1) {
      const left = removed[at]?.before ?? null;
      const right = added[at]?.after ?? null;
      paired.push({
        kind: left && right ? 'changed' : left ? 'removed' : 'added',
        before: left,
        after: right,
        block: row.block,
      });
    }
  }

  return paired;
}

/**
 * Replaces long runs of unchanged rows with a single `gap`.
 *
 * A comparison of two near-identical files is otherwise mostly a wall of
 * context the reader has to scroll past to find the four lines that moved.
 * `expanded` holds the gaps the reader has opened back up, keyed by the index
 * of the first row each one hides — an identity that survives a re-render
 * because it is derived from the row list rather than assigned.
 */
export function collapseContext(
  rows: DiffRow[],
  expanded: ReadonlySet<number> = new Set(),
  context = DIFF_CONTEXT_LINES,
  minimum = DIFF_MIN_COLLAPSE_LINES,
): DiffRow[] {
  const out: DiffRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind !== 'context') {
      out.push(rows[index]);
      continue;
    }

    const start = index;
    while (index + 1 < rows.length && rows[index + 1].kind === 'context') {
      index += 1;
    }
    const run = rows.slice(start, index + 1);

    // No context is kept at the very top or the very bottom: there is no change
    // on the other side of it to be oriented against.
    const lead = start === 0 ? 0 : context;
    const tail = index === rows.length - 1 ? 0 : context;
    const hidden = run.length - lead - tail;

    if (hidden < minimum || expanded.has(start + lead)) {
      out.push(...run);
      continue;
    }

    out.push(...run.slice(0, lead));
    out.push({
      kind: 'gap',
      before: null,
      after: null,
      block: -1,
      hidden,
      at: start + lead,
    });
    out.push(...run.slice(run.length - tail));
  }

  return out;
}

/** Every navigable change, in document order. */
export function changeBlocks(rows: DiffRow[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];

  rows.forEach((row, at) => {
    if (row.block < 0) return;

    const last = blocks[blocks.length - 1];
    const block =
      last && last.index === row.block
        ? last
        : (blocks.push({ index: row.block, row: at, added: 0, removed: 0 }),
          blocks[blocks.length - 1]);

    if (row.kind === 'added' || row.kind === 'changed') block.added += 1;
    if (row.kind === 'removed' || row.kind === 'changed') block.removed += 1;
  });

  return blocks;
}

export function diffStats(rows: DiffRow[]): DiffStats {
  let added = 0;
  let removed = 0;

  for (const row of rows) {
    if (row.kind === 'added' || row.kind === 'changed') added += 1;
    if (row.kind === 'removed' || row.kind === 'changed') removed += 1;
  }

  return { added, removed };
}

/* -------------------------------------------------------------------------- */
/* The two comparisons                                                         */
/* -------------------------------------------------------------------------- */

export interface SourceComparison {
  unified: DiffRow[];
  split: DiffRow[];
  stats: DiffStats;
}

/**
 * Thrown, rather than reported as an empty diff, when a pair of files is beyond
 * what this can usefully draw. The message is shown to the reader verbatim.
 */
export class DiffTooLargeError extends Error {
  constructor(lines: number) {
    super(
      `These files are too large to compare — ${lines.toLocaleString()} lines, ` +
        `against a limit of ${DIFF_MAX_LINES.toLocaleString()}.`,
    );
    this.name = 'DiffTooLargeError';
  }
}

export function compareSource(
  before: string,
  after: string,
  engine: DiffEngine,
): SourceComparison {
  const size = Math.max(countLines(before), countLines(after));
  if (size > DIFF_MAX_LINES) throw new DiffTooLargeError(size);

  const rows = sourceRows(engine.lines(before, after));

  return { unified: rows, split: pairRows(rows), stats: diffStats(rows) };
}

export interface RenderedComparison {
  rows: DiffRow[];
  stats: DiffStats;
}

/**
 * Compares two rendered documents block by block.
 *
 * The unit is a top-level element, not a line: the reader switched to this view
 * precisely because they did not want to look at markup, and a paragraph that
 * had one word changed should read as one changed paragraph. Blocks are matched
 * on their exact HTML, so an untouched section aligns no matter how much moved
 * above it.
 */
export function compareRendered(
  before: string[],
  after: string[],
  engine: DiffEngine,
): RenderedComparison {
  const rows = pairRows(blockRows(engine.blocks(before, after)));
  return { rows, stats: diffStats(rows) };
}

/**
 * The top-level blocks of a rendered document.
 *
 * `outerHTML` of each child, which is both the comparison key and what gets
 * drawn — it came out of the pipeline already sanitized, and round-tripping it
 * through the DOM cannot reintroduce anything the sanitizer removed.
 */
export function documentBlocks(container: Element): string[] {
  return [...container.children].map((child) => child.outerHTML);
}

/* -------------------------------------------------------------------------- */
/* Highlighting                                                                */
/* -------------------------------------------------------------------------- */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * One line of markdown, as highlighted HTML.
 *
 * Per line rather than per file, which is unusual and deliberate. A diff
 * reorders and interleaves lines from two different documents, so there is no
 * single stream to highlight — and highlighting the two files whole would mean
 * carrying open token spans across rows that are not adjacent on screen.
 * Markdown is close enough to line-oriented that the cost is small: headings,
 * lists, links, emphasis and inline code all resolve within their own line. A
 * fenced block's contents fall back to plain text, which is what a line-level
 * diff of a code fence should look like anyway.
 *
 * hljs escapes everything it does not turn into a span, and the fallback path
 * escapes by hand, so the result is safe to insert as markup.
 */
export function highlightMarkdown(line: string): string {
  if (line === '') return '';

  try {
    return hljs.highlight(line, { language: DIFF_HIGHLIGHT_LANGUAGE }).value;
  } catch {
    // An unregistered grammar or a pathological line must cost the highlight,
    // never the row.
    return escapeHtml(line);
  }
}

/* -------------------------------------------------------------------------- */
/* What the folder tree asks for                                               */
/* -------------------------------------------------------------------------- */

/**
 * A "compare this" raised by a row in the folder tree.
 *
 * The file arrives as a `read` thunk rather than as text: the tree holds a
 * `FileSystemFileHandle` and reading it is an async, permission-gated operation
 * that should not happen because a menu opened. Nothing is read until the
 * reader actually chooses to compare.
 *
 * `anchor` and `origin` are what make the menu work for both input methods —
 * where to put it, and where focus goes back to when it closes.
 */
export interface CompareRequest {
  /** Basename, for the header. */
  name: string;
  /** Path relative to the folder root, for the title attribute. */
  path: string;
  read: () => Promise<string>;
  /** Viewport coordinates for the menu, or null to place it against `origin`. */
  anchor: { x: number; y: number } | null;
  /** The row the request came from. Focus returns here. */
  origin: HTMLElement | null;
}
