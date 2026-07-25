/**
 * The markdown → sanitized HTML pipeline.
 *
 * Parsing happens exactly once per document and yields both the HTML and the
 * heading outline, because the table of contents, the anchor links and the
 * document body all have to agree on the same slugs. Deriving the outline by
 * re-scanning the DOM afterwards would work until a heading contained markup,
 * at which point the two would disagree silently.
 *
 * The parser itself is built once and reused. markdown-it keeps nothing
 * per-document on the instance — everything that varies lives in the `env`
 * object handed to `render` — so a shared instance is both correct and the
 * difference between wiring up a dozen plugins once and wiring them up again on
 * every re-render, of which the raw/rendered toggle alone produces plenty.
 *
 * Configuration for every stage lives in `config.ts`.
 */

import katexPluginModule from '@vscode/markdown-it-katex';
import DOMPurify from 'dompurify';
// The ~40-language "common" bundle. The full build pulls in ~190 grammars and
// dwarfs the rest of the extension, and the extras are languages nobody puts in
// a README.
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import container from 'markdown-it-container';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import githubAlerts from 'markdown-it-github-alerts';
import multimdTable from 'markdown-it-multimd-table';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
// A value, not just a type: task lists below have to mint a token.
import Token from 'markdown-it/lib/token.mjs';

import {
  ALERT_CLASS_PREFIX,
  ALERT_MARKERS,
  CONTAINER_TYPES,
  HIGHLIGHT_EMPTY_LANG_CLASS,
  HIGHLIGHT_LANG_PREFIX,
  KATEX_OPTIONS,
  MARKDOWN_EXTENSIONS,
  MARKDOWN_IT_OPTIONS,
  MERMAID_LANGUAGE,
  MULTIMD_TABLE_OPTIONS,
  PURIFY_CONFIG,
  TOC_LEVELS,
  WIKILINK_CLASS,
  WIKILINK_SUFFIX,
  type AlertKind,
} from './config.ts';

export interface Heading {
  id: string;
  text: string;
  level: number;
}

export interface RenderedDocument {
  html: string;
  headings: Heading[];
}

/**
 * Everything one parse accumulates. markdown-it threads this through every
 * rule, which is what makes a single shared parser instance safe: two renders
 * share the rules and share nothing else.
 */
interface RenderEnv {
  headings: Heading[];
  /** Headings whose text slugs to nothing, numbered so they still get an id. */
  unnamed: number;
}

/**
 * The KaTeX plugin is CommonJS. Bundlers unwrap its `exports.default` for us;
 * bare node — which is what runs the tests — hands back `module.exports` whole.
 */
const katexPlugin = (
  katexPluginModule as unknown as { default?: typeof katexPluginModule }
).default ?? katexPluginModule;

/* -------------------------------------------------------------------------- */
/* Slugs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * GitHub-compatible slugs, so links written against a README's own anchors
 * (`#installation`) resolve the way their author expected.
 */
function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      // Each whitespace character becomes its own hyphen rather than collapsing
      // runs — that is what github-slugger does, and it is why "Install & Setup"
      // is `install--setup`: the dropped `&` leaves two spaces behind. Collapsing
      // here would silently break hand-written anchors that target such headings.
      .replace(/\s/g, '-')
  );
}

/* -------------------------------------------------------------------------- */
/* Alerts and containers                                                       */
/* -------------------------------------------------------------------------- */

/** Inline, because the extension never loads a resource of any kind. */
const ICON_ATTRS = [
  `class="${ALERT_CLASS_PREFIX}-icon"`,
  'viewBox="0 0 16 16"',
  'width="16"',
  'height="16"',
  'fill="none"',
  'stroke="currentColor"',
  'stroke-width="1.6"',
  'stroke-linecap="round"',
  'stroke-linejoin="round"',
  'aria-hidden="true"',
].join(' ');

/**
 * One icon per alert kind, shared by `> [!NOTE]` and `:::note` alike.
 *
 * Supplied rather than taken from markdown-it-github-alerts' defaults, which
 * are GitHub's filled octicons carrying GitHub's own utility classes. These are
 * the stroked 16px shapes the rest of the viewer's chrome is drawn in.
 */
const ALERT_ICONS: Record<AlertKind, string> = {
  note: `<svg ${ICON_ATTRS}><circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v4.1M8 4.7v.1"/></svg>`,
  tip: `<svg ${ICON_ATTRS}><path d="M8 1.7a4.3 4.3 0 0 0-2.6 7.7c.4.4.7.9.7 1.4h3.8c0-.5.3-1 .7-1.4A4.3 4.3 0 0 0 8 1.7Z"/><path d="M6.4 13.1h3.2M6.9 14.9h2.2"/></svg>`,
  important: `<svg ${ICON_ATTRS}><path d="M1.9 3.2a1.3 1.3 0 0 1 1.3-1.3h9.6a1.3 1.3 0 0 1 1.3 1.3v7.2a1.3 1.3 0 0 1-1.3 1.3H7.4l-3.2 2.7v-2.7H3.2a1.3 1.3 0 0 1-1.3-1.3Z"/><path d="M8 4.6v3.1M8 9.6v.1"/></svg>`,
  warning: `<svg ${ICON_ATTRS}><path d="M7.1 2.4 1.6 12.5a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.4a1 1 0 0 0-1.8 0Z"/><path d="M8 6.2v3.1M8 11.4v.1"/></svg>`,
  caution: `<svg ${ICON_ATTRS}><path d="M5.4 1.7h5.2l3.7 3.7v5.2l-3.7 3.7H5.4l-3.7-3.7V5.4Z"/><path d="M8 4.7v3.4M8 10.9v.1"/></svg>`,
};

function alertOpen(kind: AlertKind, title: string): string {
  const prefix = ALERT_CLASS_PREFIX;
  return (
    `<div class="${prefix} ${prefix}-${kind}">` +
    `<p class="${prefix}-title">${ALERT_ICONS[kind]}${escapeHtml(title)}</p>`
  );
}

/* -------------------------------------------------------------------------- */
/* Code blocks                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The whole `<pre>`, not just its contents.
 *
 * markdown-it takes a `<pre`-prefixed return verbatim, which is the only way to
 * put `hljs` on a block whose fence carried no language — its own `langPrefix`
 * emits no class at all in that case, and `.hljs` is what the stylesheet, the
 * export and the copy button's language sniffing all read.
 */
function renderFence(code: string, info: string): string {
  const lang = info.trim();
  const className = lang
    ? `${HIGHLIGHT_LANG_PREFIX}${lang}`
    : HIGHLIGHT_EMPTY_LANG_CLASS;

  return `<pre><code class="${escapeHtml(className)}">${highlight(code, lang)}</code></pre>`;
}

function highlight(code: string, lang: string): string {
  // The mermaid add-on reads this block's text back out and feeds it to a
  // parser, so it has to survive as characters. hljs has no mermaid grammar
  // today and the branch below would already pass it through — this is the
  // explicit version, so registering one later cannot quietly shred every
  // diagram into token spans.
  if (lang === MERMAID_LANGUAGE) return escapeHtml(code);

  // An unregistered tag (```console, a typo) is common and must not throw.
  if (!lang || !hljs.getLanguage(lang)) return escapeHtml(code);

  try {
    // hljs escapes everything it does not turn into a token span.
    return hljs.highlight(code, { language: lang }).value;
  } catch {
    return escapeHtml(code);
  }
}

/* -------------------------------------------------------------------------- */
/* Math must never outrank a code span                                         */
/* -------------------------------------------------------------------------- */

const DOLLAR = 0x24;

/**
 * Under `marked` this property was free: its own `codespan` and `fences`
 * tokenizers claimed `` `$x$` `` before the math extension ever saw the `$`.
 * markdown-it orders rules differently — the KaTeX plugin installs `math_inline`
 * with `inline.ruler.after('escape', …)`, which is *before* `backticks` — so it
 * has to be re-established here.
 *
 * Most of it survives the move untouched, and that was worth measuring rather
 * than assuming: fenced and indented code are block rules that both run before
 * `math_block`, and a code span still wins whenever its backtick is the first
 * special character the tokenizer reaches, which covers `` `$x$` `` itself.
 *
 * What does not survive is a `$` that opens *before* a code span and closes
 * after it — ``A $ B `c` D $ E`` — where the plugin's closing-delimiter scan
 * walks straight through the backticks and swallows the span whole. So: if a
 * backtick appears before the next `$`, this `$` cannot be an opening
 * delimiter, and it is handed back as literal text. Refusing costs one
 * character, and the tokenizer tries again at the next `$`, so a document that
 * mixes prose dollars, code spans and real math still resolves all three.
 */
function refuseMathAcrossCodeSpans(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== DOLLAR) return false;

  const backtick = state.src.indexOf('`', state.pos + 1);
  if (backtick === -1 || backtick >= state.posMax) return false;

  const dollar = state.src.indexOf('$', state.pos + 1);
  // No closing candidate at all means the math rule would decline anyway; let
  // it, rather than second-guessing a `$` that is plainly just a dollar sign.
  if (dollar === -1 || dollar >= state.posMax || dollar < backtick) return false;

  if (!silent) state.pending += '$';
  state.pos += 1;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Wikilinks                                                                   */
/* -------------------------------------------------------------------------- */

const BRACKET = 0x5b; /* [ */

/** `scheme:` or a protocol-relative `//host`. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * `[[Page Name]]`, `[[Page|Label]]`, `[[Page#Heading]]`.
 *
 * Hand-rolled rather than taken from markdown-it-wikilinks, which cannot run
 * here: it reaches `markdown-it-regexp`, which calls node's `util.inherits` at
 * module scope, so the bundled renderer throws before it renders a character.
 * See the report — the dependency was removed rather than shimmed.
 *
 * This is also the seam. A wikilink becomes an ordinary *relative* href, which
 * is the one form the browser resolves correctly for a `file://` note, a raw
 * host and a served folder alike; `lib/links.ts` leaves it unmarked because it
 * does not leave the document's own directory. What it deliberately does not do
 * is consult the folder browser: a document opened through a directory handle
 * has no URL to resolve against (`FOLDER_DOCUMENT_SCHEME` in config.ts), so
 * teaching these links to walk a `FileSystemDirectoryHandle` belongs in
 * `lib/folder.ts` next to the rest of that plumbing, not here.
 */
function wikilink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (
    state.src.charCodeAt(start) !== BRACKET ||
    state.src.charCodeAt(start + 1) !== BRACKET
  ) {
    return false;
  }

  const end = state.src.indexOf(']]', start + 2);
  if (end === -1 || end + 2 > state.posMax) return false;

  const body = state.src.slice(start + 2, end);
  // A bracket or a line break inside means this was never one link.
  if (!body.trim() || /[[\]\n]/.test(body)) return false;

  const bar = body.indexOf('|');
  const target = (bar === -1 ? body : body.slice(0, bar)).trim();
  const label = (bar === -1 ? target : body.slice(bar + 1).trim()) || target;

  const href = wikilinkHref(target);
  // `normalizeLink` percent-encodes the spaces a real filename has in it;
  // `validateLink` is markdown-it's own refusal of `javascript:` and friends,
  // and this href came out of an untrusted document like any other.
  const normalized = state.md.normalizeLink(href);
  if (!state.md.validateLink(normalized)) return false;

  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrSet('href', normalized);
    open.attrSet('class', WIKILINK_CLASS);
    // A token rather than interpolated markup, so the label is escaped by the
    // renderer and `[[Tom & Jerry]]` keeps its ampersand.
    state.push('text', '', 0).content = labelWithoutHash(label);
    state.push('link_close', 'a', -1);
  }

  state.pos = end + 2;
  return true;
}

function wikilinkHref(target: string): string {
  const hash = target.indexOf('#');
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  // Headings are addressed by the slugs this file mints, not by their text.
  const fragment = hash === -1 ? '' : `#${slugify(target.slice(hash + 1))}`;

  // `[[#Section]]` is a link within this document.
  if (!path) return fragment;

  // A target that already names a scheme or a host is an address, not a page:
  // appending `.md` to it would only invent a file nobody has. `validateLink`
  // in the caller is what decides whether the scheme is one we will follow.
  const named =
    ABSOLUTE.test(path) ||
    MARKDOWN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

  return `${path}${named ? '' : WIKILINK_SUFFIX}${fragment}`;
}

/** `[[Page#Heading]]` shows the page, not the anchor. */
function labelWithoutHash(label: string): string {
  return label.startsWith('#') ? label.slice(1) : label.replace(/#[^#]*$/, '');
}

/* -------------------------------------------------------------------------- */
/* Task lists                                                                  */
/* -------------------------------------------------------------------------- */

const TASK_MARKER = /^\[([ xX])\]([ \t]+|$)/;

const CHECKBOX = '<input type="checkbox" disabled';

/**
 * `- [x] done`.
 *
 * Hand-rolled because markdown-it implements CommonMark, and task lists are
 * GFM: `marked` had them built in and markdown-it has them in neither core nor
 * any plugin in this set. They are not decoration — `viewer.css` restyles the
 * item, the DOCX export maps them to Word checkbox glyphs, and a README's
 * roadmap is mostly this.
 *
 * The marker is stripped from the first inline token of a list item and an
 * `<input>` is put in its place, which is exactly the shape GFM emits: a
 * disabled checkbox as the item's first child. Tight lists hide their
 * `<p>` wrapper, so `li > input:first-child` holds.
 */
function markTaskLists(tokens: Token[]): void {
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.type !== 'inline' ||
      tokens[index - 1].type !== 'paragraph_open' ||
      tokens[index - 2].type !== 'list_item_open'
    ) {
      continue;
    }

    const first = token.children?.[0];
    if (first?.type !== 'text') continue;

    const match = TASK_MARKER.exec(first.content);
    if (!match) continue;

    first.content = first.content.slice(match[0].length);
    token.content = token.content.slice(match[0].length);

    const checkbox = new Token('html_inline', '', 0);
    checkbox.content =
      match[1] === ' ' ? `${CHECKBOX}>` : `${CHECKBOX} checked>`;
    token.children!.unshift(checkbox);
  }
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

const TEXT_ALIGN = /^text-align:\s*(left|center|right)$/;

/**
 * Column alignment as an `align` attribute rather than an inline style.
 *
 * Both markdown-it's own table rule and MultiMarkdown's emit
 * `style="text-align:left"`; GFM — and therefore everything downstream here —
 * expects `align="left"`. `viewer.css` and the exported stylesheet both select
 * on `th[align]`, and the DOCX writer reads the attribute off the cell to pick
 * a Word paragraph alignment, so the attribute is the contract and the style is
 * the accident. Rewriting it also keeps one fewer inline `style` in output that
 * started life as an untrusted file.
 */
function alignAsAttribute(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type !== 'th_open' && token.type !== 'td_open') continue;

    const index = token.attrIndex('style');
    if (index < 0) continue;

    const match = TEXT_ALIGN.exec(token.attrs![index][1].trim());
    if (!match) continue;

    token.attrs!.splice(index, 1);
    token.attrSet('align', match[1]);
  }
}

/* -------------------------------------------------------------------------- */
/* The parser                                                                  */
/* -------------------------------------------------------------------------- */

function createParser(): MarkdownIt {
  const md = new MarkdownIt({
    ...MARKDOWN_IT_OPTIONS,
    highlight: renderFence,
  });

  md.use(footnote)
    // The bundled table is `full`, which is the whole Unicode shortname set and
    // no network call — the reason node-emoji was here before markdown-it was.
    // Its ASCII shortcuts (`:)`, `:-(`) are switched off: rewriting punctuation
    // that an author typed as punctuation is a surprise, not a feature.
    .use(emoji, { shortcuts: {} })
    .use(multimdTable, MULTIMD_TABLE_OPTIONS)
    .use(githubAlerts, {
      markers: [...ALERT_MARKERS],
      classPrefix: ALERT_CLASS_PREFIX,
      icons: ALERT_ICONS,
    })
    .use(katexPlugin, KATEX_OPTIONS);

  for (const { name, title, kind } of CONTAINER_TYPES) {
    md.use(container, name, {
      render: (tokens: Token[], index: number) =>
        tokens[index].nesting === 1
          ? // `:::note Heads up` names its own title; bare `:::note` takes the
            // default. The info string is the raw line, name included.
            `${alertOpen(kind, tokens[index].info.trim().slice(name.length).trim() || title)}\n`
          : '</div>\n',
    });
  }

  md.use(anchor, {
    // Every level, not just TOC_LEVELS: an `h5` is still a link target someone
    // may have written an anchor against, and `components/HeadingFold.tsx`
    // folds all six.
    level: [1, 2, 3, 4, 5, 6],
    // Off, because it is on by default and would put `tabindex="-1"` on every
    // heading in the document — a tab stop the viewer never asked for.
    tabIndex: false,
    getTokensText: headingText,
    slugifyWithState: (text: string, state: { env: RenderEnv }) => {
      const slug = slugify(text);
      if (slug) return slug;

      // A heading of pure punctuation ("???") still has to be addressable.
      state.env.unnamed += 1;
      return `section-${state.env.unnamed}`;
    },
    // Two headings with the same words are common ("Options" under each
    // command). markdown-it-anchor's own counter is per-parse and starts at 1,
    // which is exactly what GitHub does: `options`, `options-1`.
    uniqueSlugStartIndex: 1,
  });

  md.inline.ruler.before('math_inline', 'mdv_code_span_wins', refuseMathAcrossCodeSpans);
  // Before `link`, which also opens on `[` and would otherwise get first look
  // at `[[…]]`.
  md.inline.ruler.before('link', 'mdv_wikilink', wikilink);

  // Appended last, so each runs after the plugin rules it depends on — `anchor`
  // is itself a core rule pushed by `use` above, which is what lets the outline
  // read ids that have already been assigned and deduplicated.
  md.core.ruler.push('mdv_task_lists', (state) => markTaskLists(state.tokens));
  md.core.ruler.push('mdv_table_align', (state) => alignAsAttribute(state.tokens));
  md.core.ruler.push('mdv_outline', (state) => {
    collectOutline(state.tokens, state.env as RenderEnv);
  });

  return md;
}

/**
 * The visible text of a heading, as tokens rather than as rendered HTML: the
 * latter has already been entity-escaped, so "Install & Setup" comes back as
 * "Install &amp; Setup" and slugs to `install-amp-setup`. That was a shipped
 * bug once, and it is why this is the input to both the slug and the outline.
 *
 * `emoji` joins markdown-it-anchor's default two token types so a shortname
 * contributes its character rather than a hole where the token was.
 */
function headingText(tokens: Token[]): string {
  return tokens
    .filter((token) => ['text', 'code_inline', 'emoji'].includes(token.type))
    .map((token) => token.content)
    .join('');
}

/** Runs after `anchor`, so every heading already carries its final id. */
function collectOutline(tokens: Token[], env: RenderEnv): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;

    const level = Number(token.tag.slice(1));
    const id = token.attrGet('id');
    if (!id || !TOC_LEVELS.includes(level)) continue;

    env.headings.push({
      id,
      text: headingText(tokens[index + 1]?.children ?? []).trim(),
      level,
    });
  }
}

const parser = createParser();

/**
 * The source is untrusted — any site can serve a .md file containing raw HTML,
 * and markdown-it passes that through by design. Sanitize before it reaches the
 * DOM.
 */
export function renderMarkdown(source: string): RenderedDocument {
  // Slugs are per-document, so a fresh env is needed for every parse or a
  // second render would start numbering duplicates from where the first ended.
  const env: RenderEnv = { headings: [], unnamed: 0 };
  let raw: string;

  try {
    raw = parser.render(source, env);
  } catch {
    // A parser crash on pathological input must degrade to "you can still read
    // the file", never to a blank page.
    return { html: `<pre>${escapeHtml(source)}</pre>`, headings: [] };
  }

  const html = DOMPurify.sanitize(raw, PURIFY_CONFIG);

  // Sanitization can drop a heading (or its id) that the outline already
  // recorded, which would leave the table of contents pointing at nothing.
  const surviving = new Set(
    [...html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/g)].map((match) => match[1]),
  );

  return { html, headings: env.headings.filter((h) => surviving.has(h.id)) };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
