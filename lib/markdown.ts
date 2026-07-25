import DOMPurify, { type Config } from 'dompurify';
// The ~40-language "common" bundle. The full build pulls in ~190 grammars and
// dwarfs the rest of the extension, and the extras are languages nobody puts in
// a README.
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

const marked = new Marked(
  markedHighlight({
    // marked-highlight appends the language tag to this, so the emitted class is
    // `hljs language-ts` — hljs's own stylesheet keys off the `hljs` class and
    // the token spans, so both parts have to be there.
    langPrefix: 'hljs language-',
    emptyLangClass: 'hljs',

    highlight(code, lang) {
      // An unregistered tag (```mermaid, ```console, a typo) is common and must
      // not throw. Returning `code` unchanged leaves marked's own escaping in
      // charge, which is what we want for text we haven't tokenized.
      if (!lang || !hljs.getLanguage(lang)) return code;

      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch {
        return code;
      }
    },
  }),
  { async: false, gfm: true, breaks: false },
);

/**
 * Checked against DOMPurify 3.4.12: its defaults already keep the two bits of
 * GFM output that a stricter allowlist would eat — `<input type=checkbox
 * disabled>` from task lists, and `align` on th/td from `|:---:|` column
 * alignment. `ADD_ATTR` pins them anyway, so a future DOMPurify tightening its
 * defaults can't silently empty out every task list and un-align every table.
 *
 * Deliberately *not* done: no `ALLOWED_TAGS` override. Supplying one replaces
 * the whole allowlist, and rebuilding it by hand is how script/iframe/object
 * sneak back in. Everything here only narrows or pins.
 */
const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['align', 'type', 'checked', 'disabled'],
  // Nothing in markdown output needs data-*; dropping them shrinks the surface
  // for attribute-based gadgets in whatever consumes the DOM later.
  ALLOW_DATA_ATTR: false,
  // A stylesheet from an untrusted .md could reposition or hide our own UI.
  FORBID_TAGS: ['style'],
};

/**
 * The source is untrusted — any site can serve a .md file containing raw HTML,
 * and marked passes that through by design. Sanitize before it reaches the DOM.
 */
export function renderMarkdown(source: string): string {
  let raw: string;

  try {
    raw = marked.parse(source) as string;
  } catch {
    // A parser crash on pathological input must degrade to "you can still read
    // the file", never to a blank page.
    return `<pre>${escapeHtml(source)}</pre>`;
  }

  return DOMPurify.sanitize(raw, PURIFY_CONFIG);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
