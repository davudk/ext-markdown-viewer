/**
 * The matching engine.
 *
 * `lib/search.ts` is the one part of search with no DOM in it, which is why it
 * is the part worth testing: everything above it — the painted ranges, the
 * result rows, the folder walk — is a presentation of what this file decides.
 *
 * Three groups of failure are what these are really aimed at:
 *
 *   · **Offsets that lie.** A match is only ever an offset pair, and the caller
 *     turns it into a Range over live text nodes. An offset that is off by one
 *     because a case fold changed a string's length paints the highlight in the
 *     wrong place rather than failing, and nothing on screen says so.
 *   · **A scan that never returns.** A zero-width regex, or a catastrophic one.
 *     The engine has to come back either way.
 *   · **Headings read out of code fences.** A shell transcript is full of lines
 *     beginning `#`, and treating them as headings fills every breadcrumb in the
 *     panel with noise.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SEARCH_REGEX_BUDGET_MS, SEARCH_RESULT_LIMIT } from '../lib/config.ts';
import {
  breadcrumbAt,
  compilePattern,
  createCache,
  escapeRegExp,
  foldCase,
  handleRequest,
  isPatternError,
  isWordEdge,
  lineAt,
  lineStarts,
  lineText,
  prepareDocument,
  searchDocument,
  snippetAround,
  sourceOutline,
  tidy,
  type DetailedMatch,
  type Pattern,
  type SearchOptions,
} from '../lib/search.ts';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const PLAIN: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false };

function pattern(query: string, options: Partial<SearchOptions> = {}): Pattern {
  const compiled = compilePattern(query, { ...PLAIN, ...options });
  assert.ok(!isPatternError(compiled), `expected ${query} to compile`);
  return compiled;
}

function find(text: string, query: string, options: Partial<SearchOptions> = {}) {
  return searchDocument(
    prepareDocument(text),
    pattern(query, options),
    SEARCH_RESULT_LIMIT,
    SEARCH_REGEX_BUDGET_MS,
  );
}

/** The matched substrings, which is what an offset pair is *supposed* to mean. */
function hits(text: string, query: string, options: Partial<SearchOptions> = {}) {
  return find(text, query, options).matches.map(({ start, end }) => text.slice(start, end));
}

/* -------------------------------------------------------------------------- */
/* Case folding                                                                */
/* -------------------------------------------------------------------------- */

test('folding never changes the length of the string', () => {
  // The whole reason this function exists. `İ`.toLowerCase() is two code units,
  // and one of them anywhere in a document slides every later offset off its
  // text node — a highlight painted over the wrong words, with no error.
  for (const sample of ['İstanbul', 'ẞ', 'ǅ', 'Ⅷ', 'ABC', '', 'ﬀ']) {
    assert.equal(foldCase(sample).length, sample.length, sample);
  }
});

test('folding still lowercases the ordinary case', () => {
  assert.equal(foldCase('MiXeD Case'), 'mixed case');
});

test('an offset into the folded copy indexes the original', () => {
  const text = 'a İ b needle';
  const document = prepareDocument(text);
  const found = searchDocument(document, pattern('NEEDLE'), 10, SEARCH_REGEX_BUDGET_MS);

  assert.equal(found.matches.length, 1);
  assert.equal(text.slice(found.matches[0].start, found.matches[0].end), 'needle');
});

/* -------------------------------------------------------------------------- */
/* Literal matching                                                            */
/* -------------------------------------------------------------------------- */

test('literal matches are non-overlapping and in order', () => {
  assert.deepEqual(hits('aaaa', 'aa'), ['aa', 'aa']);
});

test('case sensitivity is honoured both ways', () => {
  assert.deepEqual(hits('Cat cat CAT', 'cat'), ['Cat', 'cat', 'CAT']);
  assert.deepEqual(hits('Cat cat CAT', 'cat', { caseSensitive: true }), ['cat']);
});

test('whole word does not step over a later candidate', () => {
  // `bookkeeper` contains `keep` at offset 4; a search that skipped the whole
  // rejected candidate would never see it.
  assert.deepEqual(hits('bookkeeper keep', 'keep', { wholeWord: true }), ['keep']);
  assert.equal(find('bookkeeper keep', 'keep', { wholeWord: true }).matches[0].start, 11);
});

test('word edges count digits, letters and underscores as word characters', () => {
  assert.equal(isWordEdge('a-b', 2, 3), true);
  assert.equal(isWordEdge('ab', 1, 2), false);
  assert.equal(isWordEdge('_b', 1, 2), false);
  assert.equal(isWordEdge('1b', 1, 2), false);
  assert.equal(isWordEdge('日本', 1, 2), false);
});

test('the limit is reported rather than silently applied', () => {
  const many = prepareDocument('x'.repeat(50));
  const found = searchDocument(many, pattern('x'), 10, SEARCH_REGEX_BUDGET_MS);
  assert.equal(found.matches.length, 10);
  assert.equal(found.truncated, true);

  const few = prepareDocument('x'.repeat(5));
  const all = searchDocument(few, pattern('x'), 10, SEARCH_REGEX_BUDGET_MS);
  assert.equal(all.truncated, false);
});

test('an empty query compiles to an error rather than matching everything', () => {
  assert.ok(isPatternError(compilePattern('', PLAIN)));
});

/* -------------------------------------------------------------------------- */
/* Regex matching                                                              */
/* -------------------------------------------------------------------------- */

test('a bad pattern comes back as a message, not an exception', () => {
  const compiled = compilePattern('(unclosed', { ...PLAIN, regex: true });
  assert.ok(isPatternError(compiled));
  assert.match(compiled.error, /group|Invalid/i);
});

test('escaping makes a regex-shaped query literal', () => {
  assert.deepEqual(hits('a.b axb', 'a.b'), ['a.b']);
  assert.equal(new RegExp(escapeRegExp('a.b')).test('axb'), false);
});

test('anchors mean line start and line end', () => {
  // `m` is on, so a pattern typed at a document behaves the way it does in every
  // editor rather than matching once at the very top of the file.
  assert.deepEqual(hits('one\ntwo\nthree', '^t\\w+', { regex: true }), ['two', 'three']);
});

test('a zero-width pattern terminates instead of matching forever', () => {
  const found = find('abc', 'x*', { regex: true });
  // Nothing useful to highlight, and — the point — it came back.
  assert.deepEqual(found.matches, []);
  assert.equal(found.truncated, false);
});

test('whole word composes with a regex instead of rewriting it', () => {
  // Wrapping the user's pattern in \b(?:…)\b would change what an alternation
  // means; the edge is checked on the result instead.
  assert.deepEqual(hits('cat|cats concat', 'cat|dog', { regex: true, wholeWord: true }), [
    'cat',
  ]);
});

test('a slow pattern gives up on time and says so', () => {
  // The clock is faked so the test is about the mechanism rather than about how
  // fast this machine is: every reading is past the deadline, so the first
  // budget check aborts.
  const document = prepareDocument('ab '.repeat(4000));
  let ticks = 0;
  const clock = () => {
    ticks += 1;
    return ticks === 1 ? 0 : SEARCH_REGEX_BUDGET_MS * 100;
  };

  const found = searchDocument(document, pattern('ab', { regex: true }), 10_000, 50, clock);

  assert.equal(found.timedOut, true);
  assert.ok(found.matches.length > 0, 'what was found before the deadline is still real');
  assert.ok(found.matches.length < 4000, 'and it stopped early');
});

test('a scan that finishes inside its budget is not marked as timed out', () => {
  const found = searchDocument(
    prepareDocument('ab ab ab'),
    pattern('ab', { regex: true }),
    100,
    SEARCH_REGEX_BUDGET_MS,
  );
  assert.equal(found.timedOut, false);
  assert.equal(found.matches.length, 3);
});

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

test('line starts and lookups agree with each other', () => {
  const text = 'one\ntwo\n\nfour';
  const starts = lineStarts(text);

  assert.deepEqual(starts, [0, 4, 8, 9]);
  assert.equal(lineAt(starts, 0), 0);
  assert.equal(lineAt(starts, 3), 0);
  assert.equal(lineAt(starts, 4), 1);
  assert.equal(lineAt(starts, 8), 2);
  assert.equal(lineAt(starts, 12), 3);

  assert.equal(lineText(text, starts, 0), 'one');
  assert.equal(lineText(text, starts, 2), '');
  assert.equal(lineText(text, starts, 3), 'four');
});

test('a CRLF file does not leave a carriage return in the line', () => {
  const text = 'one\r\ntwo';
  assert.equal(lineText(text, lineStarts(text), 0), 'one');
});

/* -------------------------------------------------------------------------- */
/* The source outline                                                          */
/* -------------------------------------------------------------------------- */

test('headings inside a fenced block are not headings', () => {
  const source = [
    '# Title',
    '',
    '```sh',
    '# not a heading',
    '```',
    '',
    '## Real',
  ].join('\n');

  assert.deepEqual(
    sourceOutline(source).map((heading) => heading.text),
    ['Title', 'Real'],
  );
});

test('a fence is only closed by its own marker, at its own length', () => {
  const source = ['````', '```', '# still inside', '````', '# out'].join('\n');
  assert.deepEqual(
    sourceOutline(source).map((heading) => heading.text),
    ['out'],
  );
});

test('atx headings drop their closing hashes and keep their level', () => {
  const outline = sourceOutline('### Deep ###\n#### Deeper');
  assert.deepEqual(outline, [
    { level: 3, text: 'Deep', line: 0 },
    { level: 4, text: 'Deeper', line: 1 },
  ]);
});

test('setext headings are found and reported on their text line', () => {
  const outline = sourceOutline('Title\n=====\n\nSub\n---');
  assert.deepEqual(outline, [
    { level: 1, text: 'Title', line: 0 },
    { level: 2, text: 'Sub', line: 3 },
  ]);
});

test('a horizontal rule after a blank line is not a setext heading', () => {
  assert.deepEqual(sourceOutline('text\n\n---\n'), []);
});

test('a breadcrumb is the chain of shallower headings above a line', () => {
  const source = ['# One', '## Two', '### Three', 'body', '## Four', 'body'].join('\n');
  const outline = sourceOutline(source);

  assert.deepEqual(breadcrumbAt(outline, 3), ['One', 'Two', 'Three']);
  assert.deepEqual(breadcrumbAt(outline, 5), ['One', 'Four']);
  assert.deepEqual(breadcrumbAt(outline, 0), ['One']);
});

test('text before the first heading has no breadcrumb at all', () => {
  const outline = sourceOutline('intro\n\n# One');
  assert.deepEqual(breadcrumbAt(outline, 0), []);
});

test('a gap in heading levels is reported, not invented', () => {
  const outline = sourceOutline('# One\n### Three\nbody');
  assert.deepEqual(breadcrumbAt(outline, 2), ['One', 'Three']);
});

/* -------------------------------------------------------------------------- */
/* Snippets                                                                    */
/* -------------------------------------------------------------------------- */

test('a snippet collapses whitespace and stays inside its bounds', () => {
  const text = 'first line\nsecond needle here\nthird';
  const start = text.indexOf('needle');
  const floor = text.indexOf('second');
  const ceiling = text.indexOf('\nthird');

  const snippet = snippetAround(text, start, start + 6, 100, 100, floor, ceiling);

  assert.equal(snippet.hit, 'needle');
  assert.equal(snippet.before, 'second ');
  assert.equal(snippet.after, ' here');
  // Not 'first line' and not 'third': the window is clamped to the line, so the
  // line number a row shows is the line its text came from.
  assert.ok(!snippet.before.includes('first'));
  assert.ok(!snippet.after.includes('third'));
});

test('tidy leaves a single-line snippet single-line', () => {
  assert.equal(tidy('a\n  b\tc'), 'a b c');
});

/* -------------------------------------------------------------------------- */
/* The request handler — the whole worker, minus its postMessage               */
/* -------------------------------------------------------------------------- */

test('a document is cached by key and searched by key', () => {
  const cache = createCache();
  handleRequest({ kind: 'put', key: 'a', text: 'hello world' }, cache);

  const answer = handleRequest(
    {
      kind: 'search',
      runId: 1,
      key: 'a',
      query: 'world',
      options: PLAIN,
      detail: 'offsets',
      limit: 10,
      budgetMs: 50,
    },
    cache,
  );

  assert.equal(answer?.kind, 'result');
  assert.equal(answer.kind === 'result' && answer.matches.length, 1);
});

test('a cache write produces no answer, because it is not a search', () => {
  const cache = createCache();
  assert.equal(handleRequest({ kind: 'put', key: 'a', text: 'x' }, cache), null);
  assert.equal(handleRequest({ kind: 'drop', key: 'a' }, cache), null);
});

test('searching a key that was dropped finds nothing rather than throwing', () => {
  const cache = createCache();
  handleRequest({ kind: 'put', key: 'a', text: 'hello' }, cache);
  handleRequest({ kind: 'drop', key: 'a' }, cache);

  const answer = handleRequest(
    {
      kind: 'search',
      runId: 1,
      key: 'a',
      query: 'hello',
      options: PLAIN,
      detail: 'offsets',
      limit: 10,
      budgetMs: 50,
    },
    cache,
  );

  assert.equal(answer?.kind, 'result');
  assert.equal(answer.kind === 'result' && answer.matches.length, 0);
});

test('a one-shot document may be sent with the search that reads it', () => {
  const cache = createCache();
  const answer = handleRequest(
    {
      kind: 'search',
      runId: 7,
      key: 'file:notes.md',
      text: '# Notes\n\nfind me',
      query: 'find',
      options: PLAIN,
      detail: 'lines',
      limit: 10,
      budgetMs: 50,
    },
    cache,
  );

  assert.equal(answer?.kind, 'result');
  assert.equal(answer.kind === 'result' && answer.runId, 7);
});

test('the detailed form carries the line and the breadcrumb the panel shows', () => {
  const cache = createCache();
  const source = ['# Guide', '', '## Install', '', 'run the installer', ''].join('\n');

  const answer = handleRequest(
    {
      kind: 'search',
      runId: 1,
      key: 'a',
      text: source,
      query: 'installer',
      options: PLAIN,
      detail: 'lines',
      limit: 10,
      budgetMs: 50,
    },
    cache,
  );

  assert.equal(answer?.kind, 'result');
  const [match] = (answer as { matches: DetailedMatch[] }).matches;

  assert.equal(match.line, 4);
  assert.deepEqual(match.breadcrumb, ['Guide', 'Install']);
  assert.equal(match.hit, 'installer');
  assert.equal(match.before, 'run the ');
  assert.equal(match.after, '');
});

test('an invalid regex is answered, not thrown, so the panel can print it', () => {
  const cache = createCache();
  const answer = handleRequest(
    {
      kind: 'search',
      runId: 3,
      key: 'a',
      text: 'anything',
      query: '(',
      options: { ...PLAIN, regex: true },
      detail: 'lines',
      limit: 10,
      budgetMs: 50,
    },
    cache,
  );

  assert.equal(answer?.kind, 'invalid');
  assert.equal(answer.kind === 'invalid' && answer.runId, 3);
  assert.ok(answer.kind === 'invalid' && answer.error.length > 0);
});

test('ping is answered, which is the whole liveness check', () => {
  assert.deepEqual(handleRequest({ kind: 'ping' }, createCache()), { kind: 'pong' });
});

test('re-putting a key rebuilds its structure rather than reusing the old one', () => {
  const cache = createCache();
  const search = () =>
    handleRequest(
      {
        kind: 'search',
        runId: 1,
        key: 'a',
        query: 'x',
        options: PLAIN,
        detail: 'lines',
        limit: 10,
        budgetMs: 50,
      },
      cache,
    );

  handleRequest({ kind: 'put', key: 'a', text: '# One\nx' }, cache);
  const first = search();
  assert.deepEqual(
    first?.kind === 'result' ? (first.matches as DetailedMatch[])[0].breadcrumb : null,
    ['One'],
  );

  // A live reload replaces the document under the same key. Stale line starts
  // here would report every result on the wrong line.
  handleRequest({ kind: 'put', key: 'a', text: '# Two\n\n\nx' }, cache);
  const second = search();
  assert.deepEqual(
    second?.kind === 'result' ? (second.matches as DetailedMatch[])[0].breadcrumb : null,
    ['Two'],
  );
  const moved = second?.kind === 'result' ? (second.matches as DetailedMatch[])[0] : null;
  assert.equal(moved?.line, 3);
});
