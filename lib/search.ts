/**
 * The matching engine: everything search does that is not a DOM operation.
 *
 * Nothing here touches the document, the network, or any browser API beyond
 * `performance.now()`. That is the point — this module is what runs inside the
 * Web Worker, and it is also what runs on the main thread when a worker cannot
 * be created (see `lib/search-client.ts`). One implementation, two hosts, and a
 * test file that can exercise it in bare node.
 *
 * Two shapes of text arrive here and they are deliberately not distinguished:
 *
 *   · the *rendered* document, extracted from the DOM by `components/Search.tsx`
 *     as one string with a node index kept alongside it, and
 *   · the *source* markdown of a file, which the sidebar panel searches because
 *     that is the only text a line number means anything in.
 *
 * A match is an offset pair either way. Who turns it back into a Range and who
 * turns it into a line number is the caller's business.
 *
 * It imports nothing, `lib/config.ts` included. That is not purity for its own
 * sake: this file is bundled *into* the worker, and one import of the config
 * module dragged every theme palette in the extension into the worker's blob
 * along with it. Limits arrive as arguments instead — and the values callers
 * pass are declared below, so that no caller has to reach for config either.
 */

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The limits and cache keys search runs under, held here rather than in
 * `lib/config.ts` for the reason the header gives: this module is bundled into
 * the worker, and importing the config module dragged every theme palette in
 * the extension into the worker's blob. Declaring them here costs the worker
 * nothing — they are numbers in a module it already contains — and it puts them
 * next to the code that has to explain them. `searchDocument` still takes its
 * limit and budget as arguments; these are the values callers pass.
 */

/** How many search matches to mark before giving up on a pathological query. */
export const SEARCH_MATCH_LIMIT = 2000;

/**
 * How many rows the sidebar's result list will build before it stops counting.
 *
 * Lower than SEARCH_MATCH_LIMIT because these are not the same object. A quick
 * find match is a painted range and a number in a counter; a panel result is a
 * row carrying a breadcrumb, a line number and a snippet, and a thousand of
 * those already outlasts anybody's willingness to scroll them. The panel says so
 * rather than silently stopping.
 */
export const SEARCH_RESULT_LIMIT = 1000;

/** Files a folder-wide search will read before it reports the rest unsearched. */
export const SEARCH_FILE_LIMIT = 2000;

/**
 * Keystroke settling time before a query is dispatched, in milliseconds.
 *
 * One search per pause, not one per keypress. Quick find uses a shorter one of
 * its own — it is searching a document already in memory and the reader is
 * watching the count move — while the panel may be about to read a thousand
 * files off a disk.
 */
export const SEARCH_DEBOUNCE_MS = 150;

/**
 * How long one document may be scanned before the scan is abandoned.
 *
 * This is the ReDoS budget, and `lib/search.ts` is explicit about the half of
 * the problem it can and cannot solve: the clock is only read between matches,
 * so it catches a pattern that is slow *often* and not one that is catastrophic
 * *once*. The second half is `lib/search-client.ts`, which can terminate a
 * worker that has stopped answering — the only thing that actually stops a
 * regular expression already running.
 */
export const SEARCH_REGEX_BUDGET_MS = 50;

/**
 * How long the client waits for a worker to answer before writing it off.
 *
 * Generous next to the budget above, because it has to cover a genuinely large
 * document as well as a wedged one, and terminating a worker that was merely
 * busy costs the reader a repeated search.
 */
export const SEARCH_WORKER_TIMEOUT_MS = 3000;

/**
 * Keys the worker caches documents under.
 *
 * Two, because the two halves of search read two different texts and both are
 * "this document". Quick find searches what is *rendered* — the text extracted
 * from the DOM, which is what it can paint ranges over. The panel searches the
 * markdown *source*, because a line number is a fact about a file and not about
 * a rendered tree. Files pulled out of a folder are keyed by their path under
 * the third prefix, which is what keeps a file called `source` from evicting it.
 */
export const SEARCH_DOCUMENT_KEY = 'rendered';
export const SEARCH_SOURCE_KEY = 'source';
export const SEARCH_FILE_KEY_PREFIX = 'file:';

/* -------------------------------------------------------------------------- */
/* What a search is                                                            */
/* -------------------------------------------------------------------------- */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Treat the query as a JavaScript regular expression rather than literal text. */
  regex: boolean;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

/** Half-open offsets into the text that was searched. */
export interface RawMatch {
  start: number;
  end: number;
}

export interface SearchOutcome {
  matches: RawMatch[];
  /** The limit was reached and there are more matches after the last one. */
  truncated: boolean;
  /**
   * The time budget ran out mid-scan. The matches already found are real; the
   * rest of the text was never looked at. See `searchDocument`.
   */
  timedOut: boolean;
}

/**
 * A query that has been checked and turned into something runnable.
 *
 * Literal and regex are separate cases rather than "always compile a regex"
 * because the literal path is `indexOf` over a cached lowercase copy, which on a
 * multi-megabyte document is roughly an order of magnitude faster than the
 * engine — and the literal path is the one a reader is in while typing.
 */
export type Pattern =
  | { kind: 'literal'; needle: string; folded: boolean; wholeWord: boolean }
  | { kind: 'regex'; regex: RegExp; wholeWord: boolean };

export interface PatternError {
  error: string;
}

/* -------------------------------------------------------------------------- */
/* Case folding                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lowercase without changing the length.
 *
 * A handful of code points grow when lowercased (`İ` becomes two characters),
 * and a single one of them anywhere in a README would slide every offset after
 * it off its text node — matches would then be painted in the wrong place rather
 * than merely be missed. The cheap whole-string form is checked and only falls
 * back to the per-character pass when it actually happened.
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;

  let out = '';
  for (const character of text) {
    const folded = character.toLowerCase();
    out += folded.length === character.length ? folded : character;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A text prepared for repeated searching.
 *
 * The folded copy is built once per document rather than once per keystroke,
 * which is the whole reason the worker caches documents by key instead of being
 * handed the text with every query.
 */
export interface SearchDocument {
  text: string;
  /** `text`, case-folded, offset-for-offset. */
  folded: string;
}

export function prepareDocument(text: string): SearchDocument {
  return { text, folded: foldCase(text) };
}

/* -------------------------------------------------------------------------- */
/* Compiling a query                                                           */
/* -------------------------------------------------------------------------- */

/** Everything with a meaning inside a regular expression, made literal. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A query, checked. Returns the reason instead of throwing when it is not one.
 *
 * The failure being a value rather than an exception is what lets the panel put
 * the engine's own words under the field — "Invalid regular expression:
 * /(/: Unterminated group" says far more about what to fix than any message
 * this file could invent.
 *
 * `m` is on for regex queries so `^` and `$` mean line start and line end, which
 * is what somebody typing a pattern at a document expects. `u` is deliberately
 * off: it would reject patterns that are perfectly ordinary everywhere else,
 * `\-` among them, and turning a working expression into an error is a worse
 * failure than the stricter escape rules are a feature.
 */
export function compilePattern(
  query: string,
  options: SearchOptions,
): Pattern | PatternError {
  if (query.length === 0) return { error: '' };

  if (!options.regex) {
    return {
      kind: 'literal',
      needle: options.caseSensitive ? query : foldCase(query),
      folded: !options.caseSensitive,
      wholeWord: options.wholeWord,
    };
  }

  try {
    const flags = options.caseSensitive ? 'gm' : 'gim';
    return { kind: 'regex', regex: new RegExp(query, flags), wholeWord: options.wholeWord };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : 'Invalid regular expression' };
  }
}

export function isPatternError(value: Pattern | PatternError): value is PatternError {
  return 'error' in value;
}

/* -------------------------------------------------------------------------- */
/* Word boundaries                                                             */
/* -------------------------------------------------------------------------- */

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Whole-word is applied to the *result* of a match rather than by rewriting the
 * query, which is the only way it can compose with an arbitrary regex — wrapping
 * a user's pattern in `\b(?:…)\b` changes what it means as soon as it contains
 * an alternation or an anchor.
 */
export function isWordEdge(haystack: string, start: number, end: number): boolean {
  const before = start > 0 ? haystack[start - 1] : '';
  const after = end < haystack.length ? haystack[end] : '';
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after);
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/** `performance.now()` where there is one, and a usable clock where there isn't. */
export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Every match in one document, in order, capped and time-boxed.
 *
 * **The time box is the ReDoS guard, and it is worth being exact about what it
 * can and cannot do.** A catastrophic pattern — `(a+)+$` against a long run of
 * `a` — does not return control between backtracking steps, so no amount of
 * checking the clock *here* can interrupt it: the check only runs after `exec`
 * has already come back. What the budget actually buys is the other, commoner
 * shape of the same problem, a pattern that is merely slow *per match* over a
 * large document, where thousands of cheap-ish `exec` calls add up to a hang.
 * That one is caught after ~`SEARCH_REGEX_BUDGET_MS` and reported as a timeout.
 *
 * The genuinely catastrophic single `exec` is handled one level up and by a
 * different mechanism: this function runs inside a Worker, so the wedged thread
 * is not the one painting the page, and `lib/search-client.ts` keeps a watchdog
 * that terminates and replaces a worker that has stopped answering. Termination
 * is the only thing that stops a running regex, and it is available precisely
 * because the work was moved off the main thread.
 */
export function searchDocument(
  document: SearchDocument,
  pattern: Pattern,
  limit: number,
  budgetMs: number,
  clock: () => number = now,
): SearchOutcome {
  const matches: RawMatch[] = [];
  const deadline = clock() + budgetMs;

  if (pattern.kind === 'literal') {
    const haystack = pattern.folded ? document.folded : document.text;
    const needle = pattern.needle;
    let from = 0;

    while (matches.length < limit) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) return { matches, truncated: false, timedOut: false };

      const end = at + needle.length;

      if (pattern.wholeWord && !isWordEdge(haystack, at, end)) {
        // One character on, not past the whole candidate: `bookkeeper` contains
        // a later `keep` that a longer skip would step over.
        from = at + 1;
        continue;
      }

      matches.push({ start: at, end });
      // Non-overlapping, which is what a reader counting occurrences expects.
      from = end;
    }

    return { matches, truncated: haystack.indexOf(needle, from) >= 0, timedOut: false };
  }

  const { regex, wholeWord } = pattern;
  const haystack = document.text;
  // Shared compiled patterns would otherwise carry `lastIndex` between calls.
  regex.lastIndex = 0;

  // Checked every few matches rather than every one: `now()` is cheap but not
  // free, and a document with two thousand matches would otherwise spend a
  // measurable slice of its budget measuring the budget.
  const CLOCK_EVERY = 32;
  let steps = 0;

  while (matches.length < limit) {
    const found = regex.exec(haystack);
    if (found === null) return { matches, truncated: false, timedOut: false };

    const start = found.index;
    const end = start + found[0].length;

    // A pattern that can match nothing (`a*`, `\b`) would otherwise return the
    // same empty match forever. It is also useless as a highlight, so it is
    // stepped over rather than recorded.
    if (end === start) {
      regex.lastIndex = start + 1;
      if (regex.lastIndex > haystack.length) {
        return { matches, truncated: false, timedOut: false };
      }
      continue;
    }

    if (!wholeWord || isWordEdge(haystack, start, end)) matches.push({ start, end });

    steps += 1;
    if (steps % CLOCK_EVERY === 0 && clock() > deadline) {
      return { matches, truncated: false, timedOut: true };
    }
  }

  return { matches, truncated: regex.exec(haystack) !== null, timedOut: false };
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

/** Offset of the first character of every line. Ascending, so bisectable. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
    starts.push(at + 1);
  }
  return starts;
}

/** Zero-based line an offset falls on, by bisection over `lineStarts`. */
export function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }

  return low;
}

/** The text of one line, without its terminator. */
export function lineText(text: string, starts: number[], line: number): string {
  const from = starts[line];
  const to = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  // A CRLF file leaves the carriage return inside the slice; it would otherwise
  // render as a stray glyph at the end of every snippet.
  return text.slice(from, to).replace(/\r$/, '');
}

/* -------------------------------------------------------------------------- */
/* The outline of a markdown source                                            */
/* -------------------------------------------------------------------------- */

export interface SourceHeading {
  level: number;
  text: string;
  /** Zero-based line the heading is written on. */
  line: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * Headings in a markdown source, in document order.
 *
 * Deliberately its own scanner rather than a second call into `lib/markdown.ts`:
 * this runs in a Worker with no DOM and no parser, and it runs over files the
 * reader has never opened, where building a full token stream per file to
 * recover six strings would be the expensive part of a folder-wide search.
 *
 * What it does get right is the thing a regex over `^#` gets wrong — fenced code
 * blocks. A shell transcript full of `# comment` lines would otherwise fill the
 * breadcrumbs with noise, and a document whose fence contains `#!` would report
 * a heading that is not one.
 */
export function sourceOutline(source: string): SourceHeading[] {
  const lines = source.split('\n');
  const headings: SourceHeading[] = [];
  let fence = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r$/, '');

    if (fence.length > 0) {
      // Closed by a run of the same character at least as long as the opener,
      // and nothing else on the line.
      const closing = FENCE.exec(line);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
        if (closing[2].trim().length === 0) fence = '';
      }
      continue;
    }

    const opening = FENCE.exec(line);
    if (opening) {
      fence = opening[1];
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      headings.push({
        level: atx[1].length,
        // Closing hashes are decoration, not text: `## Title ##` is `Title`.
        text: (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim(),
        line: index,
      });
      continue;
    }

    // Setext: the underline is on this line and the heading is the line above,
    // which must be a non-blank paragraph line and not itself a heading.
    const setext = SETEXT.exec(line);
    const above = index > 0 ? lines[index - 1].replace(/\r$/, '').trim() : '';
    if (setext && above.length > 0 && !ATX.test(above) && !SETEXT.test(above)) {
      headings.push({
        level: setext[1][0] === '=' ? 1 : 2,
        text: above,
        line: index - 1,
      });
    }
  }

  return headings;
}

/**
 * The chain of headings a line sits under, outermost first.
 *
 * Built by walking back from the nearest preceding heading and taking each one
 * that is shallower than the last kept — so an `h3` inside an `h1` with no `h2`
 * between them yields two entries rather than an invented gap.
 */
export function breadcrumbAt(outline: SourceHeading[], line: number): string[] {
  let at = -1;
  for (let index = 0; index < outline.length && outline[index].line <= line; index += 1) {
    at = index;
  }
  if (at < 0) return [];

  const trail: string[] = [];
  let level = Infinity;

  for (let index = at; index >= 0; index -= 1) {
    const heading = outline[index];
    if (heading.level >= level) continue;
    trail.push(heading.text);
    level = heading.level;
    if (level === 1) break;
  }

  return trail.reverse();
}

/* -------------------------------------------------------------------------- */
/* Snippets                                                                    */
/* -------------------------------------------------------------------------- */

/** Whitespace collapsed to single spaces, so a snippet is always one line. */
export function tidy(text: string): string {
  return text.replace(/\s+/g, ' ');
}

export interface Snippet {
  before: string;
  hit: string;
  after: string;
}

/**
 * A match with enough of its surroundings to be recognised, and no more.
 *
 * `floor` and `ceiling` bound the window, which is what keeps a result row on
 * the line the match is actually on: a snippet that ran into the next paragraph
 * would report a line number the reader could not see the text of.
 */
export function snippetAround(
  text: string,
  start: number,
  end: number,
  before: number,
  after: number,
  floor = 0,
  ceiling = text.length,
): Snippet {
  return {
    before: tidy(text.slice(Math.max(floor, start - before), start)).trimStart(),
    hit: tidy(text.slice(start, Math.min(ceiling, end))),
    after: tidy(text.slice(end, Math.min(ceiling, end + after))).trimEnd(),
  };
}

/* -------------------------------------------------------------------------- */
/* The worker protocol                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How much a caller wants to know about each match.
 *
 * Quick find asks for `offsets` and nothing else: it holds the same text the
 * worker does, plus the node index that turns an offset into a Range, so
 * anything more would be the same strings sent twice. The panel asks for
 * `lines`, because a line number and a breadcrumb are the two things it shows
 * and neither can be recovered from an offset without the text.
 */
export type Detail = 'offsets' | 'lines';

export interface DetailedMatch extends RawMatch {
  /** Zero-based; the panel adds one, because files are one-based to people. */
  line: number;
  /** Headings this line sits under, outermost first. */
  breadcrumb: string[];
  before: string;
  hit: string;
  after: string;
}

export type WorkerRequest =
  /** Answered with `pong`. The handshake that proves a worker actually runs. */
  | { kind: 'ping' }
  /** Cache a document under `key`, replacing whatever was there. */
  | { kind: 'put'; key: string; text: string }
  | { kind: 'drop'; key: string }
  /** Search one cached document. `text` caches it first, for one-shot files. */
  | {
      kind: 'search';
      runId: number;
      key: string;
      text?: string;
      query: string;
      options: SearchOptions;
      detail: Detail;
      limit: number;
      budgetMs: number;
    };

export type WorkerResponse =
  | { kind: 'pong' }
  | { kind: 'invalid'; runId: number; error: string }
  | {
      kind: 'result';
      runId: number;
      key: string;
      matches: RawMatch[] | DetailedMatch[];
      truncated: boolean;
      timedOut: boolean;
    };

/** Context kept either side of a match in a result row. */
const SNIPPET_BEFORE = 44;
const SNIPPET_AFTER = 96;

/**
 * Everything the worker knows, as a plain object.
 *
 * Passed in rather than held in a module so the same `handle` can serve the
 * worker and the main-thread fallback without the two sharing a cache — and so
 * a test can hand it an empty one.
 */
export interface SearchCache {
  documents: Map<string, SearchDocument>;
  /** Line starts and outline, built on first `lines` request per document. */
  structure: Map<string, { starts: number[]; outline: SourceHeading[] }>;
}

export function createCache(): SearchCache {
  return { documents: new Map(), structure: new Map() };
}

/**
 * One request in, at most one response out.
 *
 * The whole worker is this function plus a `postMessage`, which is what lets the
 * main-thread fallback be the same code path rather than a second implementation
 * that drifts. It is pure apart from the cache it is handed.
 */
export function handleRequest(
  request: WorkerRequest,
  cache: SearchCache,
  clock: () => number = now,
): WorkerResponse | null {
  if (request.kind === 'ping') return { kind: 'pong' };

  if (request.kind === 'put') {
    cache.documents.set(request.key, prepareDocument(request.text));
    cache.structure.delete(request.key);
    return null;
  }

  if (request.kind === 'drop') {
    cache.documents.delete(request.key);
    cache.structure.delete(request.key);
    return null;
  }

  const { runId, key, detail, limit, budgetMs } = request;

  if (request.text !== undefined) {
    cache.documents.set(key, prepareDocument(request.text));
    cache.structure.delete(key);
  }

  const document = cache.documents.get(key);
  if (!document) {
    return { kind: 'result', runId, key, matches: [], truncated: false, timedOut: false };
  }

  const pattern = compilePattern(request.query, request.options);
  if (isPatternError(pattern)) {
    return { kind: 'invalid', runId, error: pattern.error };
  }

  const found = searchDocument(document, pattern, limit, budgetMs, clock);

  if (detail === 'offsets') {
    return {
      kind: 'result',
      runId,
      key,
      matches: found.matches,
      truncated: found.truncated,
      timedOut: found.timedOut,
    };
  }

  const text = document.text;
  let structure = cache.structure.get(key);
  if (!structure) {
    structure = { starts: lineStarts(text), outline: sourceOutline(text) };
    cache.structure.set(key, structure);
  }

  const { starts, outline } = structure;

  const matches: DetailedMatch[] = found.matches.map(({ start, end }) => {
    const line = lineAt(starts, start);
    // Clamped to the line, so a row's snippet is text from the line its number
    // points at and not the paragraph that happens to follow it.
    const floor = starts[line];
    const ceiling = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;

    return {
      start,
      end,
      line,
      breadcrumb: breadcrumbAt(outline, line),
      ...snippetAround(text, start, end, SNIPPET_BEFORE, SNIPPET_AFTER, floor, ceiling),
    };
  });

  return {
    kind: 'result',
    runId,
    key,
    matches,
    truncated: found.truncated,
    timedOut: found.timedOut,
  };
}
