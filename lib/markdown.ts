/**
 * The markdown → sanitized HTML pipeline.
 *
 * Parsing happens exactly once per document and yields both the HTML and the
 * heading outline, because the table of contents, the anchor links and the
 * document body all have to agree on the same slugs. Deriving the outline by
 * re-scanning the DOM afterwards would work until a heading contained markup,
 * at which point the two would disagree silently.
 *
 * Configuration for every stage lives in `config.ts`.
 */

import DOMPurify from 'dompurify';
// The ~40-language "common" bundle. The full build pulls in ~190 grammars and
// dwarfs the rest of the extension, and the extras are languages nobody puts in
// a README.
import hljs from 'highlight.js/lib/common';
import { Marked, type Tokens } from 'marked';
import { markedEmoji } from 'marked-emoji';
import markedFootnote from 'marked-footnote';
import { markedHighlight } from 'marked-highlight';
import { search as searchEmoji } from 'node-emoji';

import {
  HIGHLIGHT_EMPTY_LANG_CLASS,
  HIGHLIGHT_LANG_PREFIX,
  MARKED_OPTIONS,
  PURIFY_CONFIG,
  TOC_LEVELS,
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

/**
 * Emoji shortnames resolved from a bundled table. `marked-emoji`'s own README
 * builds this map from GitHub's emoji API — a network call, and therefore out
 * of the question here — so it is built from node-emoji's offline data instead.
 *
 * It has to be a real object: the extension enumerates the keys to build its
 * matching regex, so a lazy Proxy resolves nothing.
 */
const EMOJI_MAP: Record<string, string> = Object.fromEntries(
  searchEmoji('').map(({ name, emoji }) => [name, emoji]),
);

const emojiExtension = markedEmoji({
  emojis: EMOJI_MAP,
  renderer: (token: { emoji: string }) => token.emoji,
});

function createParser() {
  // Slugs are per-document, so a fresh counter is needed for every parse or a
  // second render would start numbering duplicates from where the first ended.
  const seen = new Map<string, number>();
  const headings: Heading[] = [];

  const marked = new Marked(
    markedHighlight({
      langPrefix: HIGHLIGHT_LANG_PREFIX,
      emptyLangClass: HIGHLIGHT_EMPTY_LANG_CLASS,

      highlight(code, lang) {
        // An unregistered tag (```mermaid, ```console, a typo) is common and
        // must not throw. Returning `code` unchanged leaves marked's own
        // escaping in charge, which is what we want for untokenized text.
        if (!lang || !hljs.getLanguage(lang)) return code;

        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          return code;
        }
      },
    }),
    markedFootnote(),
    emojiExtension,
    MARKED_OPTIONS,
    {
      renderer: {
        heading(this: { parser: { parseInline: (t: Tokens.Generic[]) => string } }, token: Tokens.Heading) {
          const text = token.tokens
            ? this.parser.parseInline(token.tokens)
            : token.text;
          // Derived from the tokens, not from `text`: the rendered HTML has
          // already been entity-escaped, so "Install & Setup" would come back
          // as "Install &amp; Setup" and slug to `install-amp-setup`.
          const plain = plainText(token.tokens) || token.text;

          let id = slugify(plain);
          if (!id) id = `section-${headings.length + 1}`;

          // Two headings with the same words are common ("Options" under each
          // command). GitHub disambiguates with a numeric suffix; match it so
          // hand-written anchors keep working.
          const count = seen.get(id) ?? 0;
          seen.set(id, count + 1);
          if (count > 0) id = `${id}-${count}`;

          if (TOC_LEVELS.includes(token.depth)) {
            headings.push({ id, text: plain, level: token.depth });
          }

          return `<h${token.depth} id="${id}">${text}</h${token.depth}>\n`;
        },
      },
    },
  );

  return { marked, headings };
}

/** The visible text of an inline token tree, with markup and entities resolved. */
function plainText(tokens?: Tokens.Generic[]): string {
  if (!tokens) return '';

  return tokens
    .map((token) => {
      if (Array.isArray(token.tokens) && token.type !== 'codespan') {
        return plainText(token.tokens as Tokens.Generic[]);
      }
      return typeof token.text === 'string' ? token.text : '';
    })
    .join('')
    .trim();
}

/**
 * The source is untrusted — any site can serve a .md file containing raw HTML,
 * and marked passes that through by design. Sanitize before it reaches the DOM.
 */
export function renderMarkdown(source: string): RenderedDocument {
  const { marked, headings } = createParser();
  let raw: string;

  try {
    raw = marked.parse(source) as string;
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

  return { html, headings: headings.filter((h) => surviving.has(h.id)) };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
