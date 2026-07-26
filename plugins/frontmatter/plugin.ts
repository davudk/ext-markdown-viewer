/**
 * YAML frontmatter: stripped from the source, shown as a card.
 *
 * Frontmatter is metadata, not markdown. Left in the source it renders as a
 * stray table (`---` above a line with a colon is close enough to a setext
 * heading plus a paragraph) or as a horizontal rule, which is why the two
 * halves of this plugin have to be one plugin: the block is removed *and*
 * presented, or neither.
 *
 * **Where the split goes.** The strip is a `markdownIt` core rule inserted
 * before `normalize`, because that is the only point at which the raw source is
 * still a string and no rule has tokenized it yet. The card is a `ui`
 * contribution into `document.before`. The two do not talk to each other: they
 * both call `parseFrontmatter` on the same input, the rule on `state.src` and
 * the card on `ctx.document.source`, which are the same document. The
 * alternative — stashing the block on the parse `env` — would need
 * `renderMarkdown` to widen its `{ html, headings }` contract to carry it back
 * out, and `env` never reaches React anyway. Parsing a frontmatter block twice
 * costs microseconds; changing the pipeline's return type costs every caller.
 *
 * Disabled, nothing strips and nothing renders, so the block falls through to
 * markdown exactly as it did before this plugin existed. That is the residue
 * test, and it is why the strip is not done in `lib/markdown.ts`.
 *
 * **The `---` false positive.** A document may legitimately open with a
 * horizontal rule, and `---` is also a setext underline. The structural test is
 * deliberately narrow — see `splitFrontmatter`.
 *
 * **TOML (`+++`) and JSON frontmatter are passed through untouched.** Neither
 * is parsed and neither is stripped: js-yaml cannot read them, and a card built
 * from a block this plugin does not understand would be a guess shown as fact.
 * Passing through is also the harmless option — unlike `---`, a `+++` fence or
 * a leading `{ … }` renders as an ordinary paragraph rather than as a rule or a
 * table, so the reader sees the block and nothing is silently lost.
 *
 * Split from `index.tsx` because `node --experimental-strip-types` refuses a
 * `.tsx` outright, and a plugin no unit test can load is not worth the
 * abstraction.
 */

import { load } from 'js-yaml';
import type MarkdownIt from 'markdown-it';
import type { ComponentType } from 'react';

import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const FRONTMATTER_PLUGIN_ID = 'frontmatter';

/** Above the document, where the metadata for it belongs. */
export const FRONTMATTER_REGION = 'document.before';

const settings = {
  display: {
    type: 'enum',
    default: 'card',
    label: 'Frontmatter',
    description:
      'How the metadata block at the top of a document is shown. It is removed from the document either way — it is not markdown.',
    options: [
      { value: 'card', label: 'Metadata card' },
      { value: 'raw', label: 'The block as written' },
      { value: 'hidden', label: 'Not shown' },
    ],
  },
} as const;

export type FrontmatterSettings = typeof settings;
export type FrontmatterDisplay = 'card' | 'raw' | 'hidden';

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The opening fence: three or more dashes alone on the very first line.
 *
 * Anchored at offset zero after an optional BOM — frontmatter that is not the
 * first thing in the file is not frontmatter, it is a rule in the middle of a
 * document that happens to start with a blank line.
 */
const OPEN = /^\uFEFF?-{3,}[ \t]*\r?\n/;

/** `---` or YAML's `...` end-of-document marker, alone on a line. */
const CLOSE = /^(?:-{3,}|\.{3,})[ \t]*$/;

export interface FrontmatterBlock {
  /** The delimiters and everything between them, as written. */
  readonly raw: string;
  /** Just the YAML, without the delimiter lines. */
  readonly body: string;
  /** The document with the block removed. */
  readonly rest: string;
}

/**
 * The structural half, with no YAML parser involved.
 *
 * Four conditions, and every one of them exists to reject a `---` that is a
 * horizontal rule rather than a fence:
 *
 *  1. the fence is the first line of the file;
 *  2. a closing `---` (or `...`) exists later in the document — an opening rule
 *     with no partner is just a rule, and this alone rejects the common
 *     `---\n# Title` opening;
 *  3. the line immediately after the fence is not blank — `---\n\nIntro` is a
 *     rule followed by a paragraph, and no YAML document opens with a blank
 *     line it did not need;
 *  4. the body is not entirely whitespace — `---\n---` is two rules, or a
 *     setext `h2` with no text, but it is not metadata.
 *
 * What it deliberately does *not* do is require the body to parse: a malformed
 * block is still a frontmatter block, and hiding it because js-yaml choked on
 * it would lose the reader's own content.
 */
export function splitFrontmatter(source: string): FrontmatterBlock | null {
  const open = OPEN.exec(source);
  if (!open) return null;

  const afterOpen = open[0].length;
  const lines = source.slice(afterOpen).split('\n');

  // (3) — the first body line, blank means a rule.
  if (lines.length === 0 || lines[0].trim() === '') return null;

  let cursor = afterOpen;
  for (const line of lines) {
    const bare = line.endsWith('\r') ? line.slice(0, -1) : line;

    if (CLOSE.test(bare)) {
      const body = source.slice(afterOpen, cursor);
      // (4) — a fence pair around nothing is a pair of rules.
      if (body.trim() === '') return null;

      const end = cursor + line.length;
      const raw = source.slice(0, end);
      // Blank lines between the fence and the document belong to the block's
      // formatting, not to the text: leaving them would push the first heading
      // down and make "did this file have frontmatter" visible as whitespace.
      const rest = source.slice(end).replace(/^(?:[ \t]*\r?\n)+/, '');
      return { raw, body, rest };
    }

    cursor += line.length + 1;
  }

  // (2) — no closing fence anywhere: an opening horizontal rule.
  return null;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

export interface Frontmatter extends FrontmatterBlock {
  /**
   * The mapping, when the block is one. `null` covers both halves of "cannot be
   * shown as fields": a parse error, and a block that parses to something that
   * is not a mapping (`- a\n- b`, or a bare scalar). Both are shown raw.
   */
  readonly data: Readonly<Record<string, unknown>> | null;
  /** Why `data` is null, for the card to explain itself. Never thrown. */
  readonly error: string | null;
}

/**
 * Parse, and never throw.
 *
 * This is the load-bearing requirement of the whole plugin: the input is an
 * untrusted file off the web, half-written frontmatter is extremely common
 * (a tab in the indentation is enough), and a viewer that shows an error page
 * instead of the document has failed at its one job. Every failure path here
 * ends at "show the block as the author wrote it".
 *
 * `load` only, with the default schema. `load` in js-yaml v4 *is* the safe
 * schema — the v3 `safeLoad` was renamed to it — so no `!!js/function` or other
 * code-bearing type is constructible from a document. No custom types are
 * registered, deliberately.
 */
export function parseFrontmatter(source: string): Frontmatter | null {
  const block = splitFrontmatter(source);
  if (!block) return null;

  let value: unknown;
  try {
    value = load(block.body, {
      // Named in the message js-yaml builds, so a reader with a broken block is
      // told which block rather than which line of nothing.
      filename: 'frontmatter',
      // A duplicate key is a mistake worth surfacing rather than silently
      // resolving to the last one — and surfacing it costs the reader nothing,
      // because the raw block is shown either way.
      json: false,
    });
  } catch (error) {
    return { ...block, data: null, error: messageOf(error) };
  }

  if (!isMapping(value)) {
    return {
      ...block,
      data: null,
      // Not an error in YAML's eyes, so it is phrased as a description.
      error: value == null ? 'The block is empty.' : 'The block is not a set of fields.',
    };
  }

  return { ...block, data: value, error: null };
}

/** The document with any frontmatter removed. Unchanged when there is none. */
export function stripFrontmatter(source: string): string {
  return splitFrontmatter(source)?.rest ?? source;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The block could not be parsed.';
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

/** Fields the card gives their own row, in the order it shows them. */
export const FEATURED = ['title', 'author', 'date'] as const;

/** Keys treated as `title`/`author`/`date`, lowercased. */
const ALIASES: Readonly<Record<string, string>> = {
  title: 'title',
  name: 'title',
  author: 'author',
  authors: 'author',
  by: 'author',
  date: 'date',
  created: 'date',
  published: 'date',
};

/** Keys whose value is shown as chips rather than as text. */
const TAG_KEYS = new Set(['tags', 'tag', 'keywords', 'categories']);

export interface CardField {
  /** The key as the author wrote it. */
  key: string;
  /** Text. Always text — see `formatValue`. */
  value: string;
  chips?: string[];
}

export interface CardModel {
  title?: string;
  author?: string;
  date?: string;
  tags: string[];
  /** Everything else, in document order. */
  fields: CardField[];
}

/**
 * The mapping as the card shows it: three known fields, tags as chips, the rest
 * as key/value — and **every leaf already a string**.
 *
 * Flattening to strings here rather than in the component is what makes "nothing
 * is injected as HTML" checkable by a test rather than by reading JSX. The
 * component renders these as text children and nothing else; DOMPurify does not
 * run on this card, and the values came out of an untrusted document.
 */
export function cardModel(data: Readonly<Record<string, unknown>>): CardModel {
  const model: CardModel = { tags: [], fields: [] };

  for (const [key, value] of Object.entries(data)) {
    const lower = key.trim().toLowerCase();

    if (TAG_KEYS.has(lower)) {
      model.tags.push(...tagsOf(value));
      continue;
    }

    const featured = ALIASES[lower];
    if (featured && !model[featured as 'title' | 'author' | 'date']) {
      const text = formatValue(value);
      if (text) {
        model[featured as 'title' | 'author' | 'date'] = text;
        continue;
      }
    }

    model.fields.push({ key, value: formatValue(value) });
  }

  return model;
}

/** `tags: [a, b]`, `tags: a, b` and `tags: a` all mean the same thing. */
function tagsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(formatValue).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  const text = formatValue(value);
  return text ? [text] : [];
}

/**
 * Any YAML value as one line of text.
 *
 * The default schema resolves timestamps to `Date` and `~` to `null`, so this
 * is not `String(value)`: an unformatted `Date` prints a local-timezone string
 * for a value the author wrote as a date, and `String(null)` prints "null"
 * where the author meant "nothing".
 *
 * Nesting is flattened rather than rendered as a tree. A card is a summary; a
 * document whose frontmatter carries a three-level object is better served by
 * the `raw` display, which is one setting away.
 */
export function formatValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return value.map(formatValue).filter(Boolean).join(', ');
  }

  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => `${key}: ${formatValue(nested)}`)
      .join(', ');
  }

  // Symbols and functions cannot come out of the safe schema, but `unknown` is
  // `unknown` and this is the branch that keeps it text.
  return '';
}

/** A date-only value stays date-only; anything with a time keeps it, in UTC. */
function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}

/* -------------------------------------------------------------------------- */
/* The plugin                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The core rule that removes the block.
 *
 * `before('normalize')` — the first rule in the core chain — because `state.src`
 * is the only representation of the document that is still the author's text.
 * Positioned against a *core markdown-it rule name*, so no registry edit can
 * move it: whatever else is loaded before or after this plugin, `normalize` is
 * where it is.
 *
 * It runs unconditionally, not per the `display` setting. Stripping is about
 * what the block *is* — not markdown — while `display` is about what the reader
 * is shown; tying them together would mean "hide the card" silently put a stray
 * table back in the document.
 */
export function installFrontmatterRule(md: MarkdownIt): void {
  md.core.ruler.before('normalize', 'mdv_frontmatter', (state) => {
    if (typeof state.src !== 'string') return;
    state.src = stripFrontmatter(state.src);
  });
}

export function createFrontmatterPlugin(
  component: ComponentType,
): Plugin<FrontmatterSettings> {
  return {
    id: FRONTMATTER_PLUGIN_ID,
    name: 'Frontmatter',
    description: 'Shows the metadata block at the top of a document, and keeps it out of the text.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    settings,

    markdownIt: installFrontmatterRule,

    // No `setup`: there is nothing imperative to own. The card reads the source
    // and its own settings through hooks, so it unmounts with the plugin and
    // there is no teardown to get wrong.
    ui: [{ region: FRONTMATTER_REGION, key: 'card', order: 10, component }],
  };
}
