/**
 * The markdown → sanitized HTML pipeline.
 *
 * What is left here after the migration is everything that is not optional: the
 * parser's construction, the code-block markup, the sanitization, the crash
 * fallback, and the `{ html, headings }` contract. Every *syntax* — footnotes,
 * emoji, alerts, containers, extended tables, math, mermaid fences, wikilinks,
 * heading anchors — is a plugin, applied through `host.applyMarkdownIt(md)`.
 *
 * Parsing happens exactly once per document and yields both the HTML and the
 * heading outline, because the table of contents, the anchor links and the
 * document body all have to agree on the same slugs. Deriving the outline by
 * re-scanning the DOM afterwards would work until a heading contained markup,
 * at which point the two would disagree silently. The outline now arrives from
 * `plugins/markdown-headings` through the parse `env` — see
 * `lib/markdown-env.ts`, which is the whole of that seam.
 *
 * The parser is built once and reused. markdown-it keeps nothing per-document
 * on the instance — everything that varies lives in the `env` handed to
 * `render` — so a shared instance is both correct and the difference between
 * wiring up a dozen plugins once and wiring them up again on every re-render,
 * of which the raw/rendered toggle alone produces plenty. It is rebuilt only
 * when the set of enabled plugins could have changed, because a markdown-it
 * instance cannot un-apply a plugin.
 *
 * Configuration for every stage lives in `config.ts`.
 */

import DOMPurify from 'dompurify';
// The ~40-language "common" bundle. The full build pulls in ~190 grammars and
// dwarfs the rest of the extension, and the extras are languages nobody puts in
// a README.
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
// A value, not just a type: task lists below have to mint a token.
import Token from 'markdown-it/lib/token.mjs';

import {
  HIGHLIGHT_EMPTY_LANG_CLASS,
  HIGHLIGHT_LANG_PREFIX,
  MARKDOWN_IT_OPTIONS,
  PURIFY_CONFIG,
} from './config.ts';
import { escapeHtml } from './escape.ts';
import { createRenderEnv, type Heading } from './markdown-env.ts';

export type { Heading } from './markdown-env.ts';
// Re-exported rather than moved outright: `lib/export.ts`, `lib/diff.ts` and
// the add-ons all import it from here, and its new home exists only to keep
// plugins from importing the module that imports them.
export { escapeHtml } from './escape.ts';

export interface RenderedDocument {
  html: string;
  headings: Heading[];
}

/* -------------------------------------------------------------------------- */
/* The plugin host                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What this module needs from the host, and nothing more.
 *
 * Structural rather than an import of `PluginHost`: the host's registry imports
 * every plugin, and every markdown plugin imports `lib/plugins/types.ts`, which
 * type-imports this file. Naming the two methods used keeps that graph acyclic
 * at runtime, and makes the seam testable with an object literal.
 */
export interface MarkdownItHost {
  applyMarkdownIt(md: MarkdownIt): void;
  /** Bumps when a plugin is enabled or disabled. Optional: the seam works without it. */
  readonly status?: { subscribe(listener: () => void): () => void };
}

let host: MarkdownItHost | null = null;
let unsubscribe: (() => void) | null = null;
let parser: MarkdownIt | null = null;

/**
 * Hands the pipeline its plugins. Called once by the shell, at startup.
 *
 * Until it is, `renderMarkdown` still works and still sanitizes — it simply
 * renders CommonMark plus this file's own baseline. That is a deliberate
 * degradation rather than a throw: the reader gets the document, and a shell
 * that forgot to wire the host has a visible symptom rather than a blank page.
 */
export function setMarkdownHost(next: MarkdownItHost | null): void {
  unsubscribe?.();
  unsubscribe = null;
  host = next;
  parser = null;

  try {
    // Enabling or disabling a plugin has to rebuild the parser, and the host
    // already publishes the only signal that can happen. Subscribing here means
    // no caller has to remember to invalidate.
    unsubscribe = next?.status?.subscribe(() => {
      parser = null;
    }) ?? null;
  } catch {
    // A host that cannot be subscribed to still parses; it just needs
    // `setMarkdownHost` called again to pick up a toggle.
  }
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
 *
 * `plugins/markdown-mermaid` wraps this option rather than replacing it, so a
 * mermaid fence never reaches the highlighter and everything else still does.
 */
function renderFence(code: string, info: string): string {
  const lang = info.trim();
  const className = lang
    ? `${HIGHLIGHT_LANG_PREFIX}${lang}`
    : HIGHLIGHT_EMPTY_LANG_CLASS;

  return `<pre><code class="${escapeHtml(className)}">${highlight(code, lang)}</code></pre>`;
}

function highlight(code: string, lang: string): string {
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
 * Not a plugin, for the same reason `alignAsAttribute` is not: both restore
 * baseline GFM output that the rest of the extension reads unconditionally, so
 * a switch that turned them off would be a switch for breaking the export.
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
 * on `th[align]`, and the DOCX writer (`lib/export.ts`) reads the attribute off
 * the cell to pick a Word paragraph alignment, so the attribute is the contract
 * and the style is the accident. Rewriting it also keeps one fewer inline
 * `style` in output that started life as an untrusted file.
 *
 * It stays here rather than moving into `plugins/markdown-tables`, because the
 * *core* table rule emits the same style: disabling the extended-tables plugin
 * would otherwise un-align every ordinary GFM table and silently change what
 * the export produces.
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

  // Before this file's own core rules, so the ordering the pipeline had before
  // the migration is preserved exactly: plugin rules first, baseline last. The
  // host isolates each plugin, so one that throws costs its own syntax and
  // nothing else.
  try {
    host?.applyMarkdownIt(md);
  } catch (error) {
    // The host boundary already caught anything a plugin threw; reaching here
    // means the host itself failed, and a document is still owed to the reader.
    console.error('[mdv] markdown plugins could not be applied', error);
  }

  md.core.ruler.push('mdv_task_lists', (state) => markTaskLists(state.tokens));
  md.core.ruler.push('mdv_table_align', (state) => alignAsAttribute(state.tokens));

  return md;
}

/**
 * The source is untrusted — any site can serve a .md file containing raw HTML,
 * and markdown-it passes that through by design. Sanitize before it reaches the
 * DOM.
 */
export function renderMarkdown(source: string): RenderedDocument {
  parser ??= createParser();

  // Slugs are per-document, so a fresh env is needed for every parse or a
  // second render would start numbering duplicates from where the first ended.
  const env = createRenderEnv();
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
