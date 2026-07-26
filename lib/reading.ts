/**
 * How much there is to read: the prose walk, the word count, and the estimate
 * that follows from it.
 *
 * Everything is measured from the *rendered* document rather than from the
 * markdown source, because the source counts its own syntax as text — every
 * `**`, every table pipe, every link target — and a README that is mostly
 * tables reads forty percent longer that way.
 *
 * Nothing here reads a global. The walk takes the element it is handed and the
 * counting is string math, so the whole module runs under a bare node test with
 * a jsdom element passed in.
 */

/**
 * Reading speed for whitespace-delimited prose, in words per minute.
 *
 * Middling silent-reading rates for adults land between 200 and 260 wpm on
 * ordinary text; documentation sits at the slower end of that, so this is
 * deliberately not the flattering number.
 */
export const READING_WORDS_PER_MINUTE = 220;

/**
 * Reading speed for CJK text, in *characters* per minute.
 *
 * A separate rate because a Chinese, Japanese or Korean character carries far
 * more than a Latin one — timing them at the same rate as words would report a
 * page of Chinese as a ten-second read.
 */
export const READING_CJK_PER_MINUTE = 480;

export interface ReadingStats {
  /**
   * Countable units: whitespace-delimited words, plus one per CJK character.
   * This is the number the reader is shown.
   */
  words: number;
  /** How many of those units were single CJK characters. */
  cjkCharacters: number;
  /** Code blocks left out of the count entirely. Reported, never hidden. */
  codeBlocks: number;
  /** Whole minutes, at least one when there is anything at all to read. */
  minutes: number;
}

/** `Node.TEXT_NODE` and `Node.ELEMENT_NODE` by value — `lib/` runs in node too. */
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Subtrees that sit inside the document body but are not the document.
 *
 * `pre` is the substantive exclusion: a 400-line config file pasted into a
 * README is not four hundred lines of reading, and counting it makes the
 * estimate useless for exactly the documents that need one. Inline `<code>` is
 * deliberately *not* excluded — "run `npm install` first" is a sentence a
 * reader reads at prose speed, and dropping its middle would undercount
 * ordinary technical writing.
 *
 * `svg` covers rendered mermaid diagrams and KaTeX's drawn glyphs; the chrome
 * classes cover the copy buttons and heading anchors `Document.tsx` grafts on,
 * whose "Copy"/"Copied"/"Failed" faces are real text nodes in the body. The
 * KaTeX MathML twin would count every formula a second time.
 */
const SKIP_SUBTREE =
  'pre, script, style, template, svg, .mdv-copy, .mdv-anchor, .katex-mathml, [data-mdv-chrome]';

/**
 * Elements whose content starts on its own line.
 *
 * Text nodes are concatenated as they are found, so without a separator here
 * `<td>one</td><td>two</td>` counts as a single word. Only block-level tags get
 * one: inserting a space around every inline element would split `<b>hel</b>lo`
 * into two.
 */
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV',
  'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR',
  'UL',
]);

/**
 * Scripts that are read character by character rather than in whitespace-
 * delimited words. Chinese, Japanese and Korean prose has no spaces between
 * words, so counting whitespace tokens reports a 3,000-character page as a
 * handful of words and a reading time of nothing.
 */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * A word: something that begins with a letter or a digit and runs to the next
 * whitespace. Starting on `\p{L}\p{N}` is what keeps a rule of em dashes, a
 * lone `|`, or a row of `---` from counting — punctuation is never a word on
 * its own, but it is part of one when it is attached (`state-of-the-art`,
 * `don't`, `3.14`).
 */
const WORD = /[\p{L}\p{N}][^\s]*/gu;

/** Counts words and CJK characters in already-extracted text. */
export function measureText(text: string): {
  words: number;
  cjkCharacters: number;
} {
  let cjkCharacters = 0;
  CJK.lastIndex = 0;
  while (CJK.exec(text) !== null) cjkCharacters += 1;

  // Only pay for the copy when there is something to strip. Leaving the
  // characters in would count a run of them a second time, as one long
  // whitespace-delimited "word".
  const spaced = cjkCharacters > 0 ? text.replace(CJK, ' ') : text;

  let words = 0;
  WORD.lastIndex = 0;
  while (WORD.exec(spaced) !== null) words += 1;

  return { words: words + cjkCharacters, cjkCharacters };
}

/**
 * Minutes at the configured speeds, rounded to something a reader can act on.
 *
 * The two scripts are timed separately because they are read at genuinely
 * different rates per unit, and a mixed document should not be estimated at
 * whichever rate happens to dominate. Anything non-empty is at least one
 * minute: "0 min read" says nothing useful.
 */
export function readingMinutes({
  words,
  cjkCharacters,
}: {
  words: number;
  cjkCharacters: number;
}): number {
  const prose = Math.max(0, words - cjkCharacters);
  const raw =
    prose / READING_WORDS_PER_MINUTE + cjkCharacters / READING_CJK_PER_MINUTE;

  return raw > 0 ? Math.max(1, Math.round(raw)) : 0;
}

/**
 * The readable text of a rendered document, and the number of code blocks that
 * were left out of it.
 *
 * An explicit stack rather than recursion, and a live `childNodes` read rather
 * than a copy: this runs over a document that can be several megabytes, and
 * deeply quoted or generated HTML is exactly the input that would otherwise
 * overflow the call stack. One `matches` call per element skips a whole subtree
 * for the cost of a selector test, which is what keeps the pass proportional to
 * the prose rather than to the markup.
 */
export function collectProse(root: Element): {
  text: string;
  codeBlocks: number;
} {
  const parts: string[] = [];
  let codeBlocks = 0;

  const stack: Node[] = [root];

  while (stack.length > 0) {
    const node = stack.pop() as Node;

    if (node.nodeType === TEXT_NODE) {
      parts.push((node as Text).data);
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;

    const element = node as Element;
    // SVG elements report a lowercase tagName; HTML ones an uppercase one.
    const tag = element.tagName.toUpperCase();

    if (element !== root && element.matches(SKIP_SUBTREE)) {
      if (tag === 'PRE') codeBlocks += 1;
      continue;
    }

    if (BLOCK.has(tag)) parts.push(' ');

    // Children in reverse, so popping walks them in document order — which is
    // what puts the separator above ahead of the content it separates.
    const children = element.childNodes;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }

  return { text: parts.join(''), codeBlocks };
}

/** Everything the reading readout shows, for one rendered document. */
export function readingStats(root: Element): ReadingStats {
  const { text, codeBlocks } = collectProse(root);
  const counted = measureText(text);

  return { ...counted, codeBlocks, minutes: readingMinutes(counted) };
}
