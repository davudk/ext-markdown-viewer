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
 * DOMPurify's default allowlist covers everything marked emits *except* a couple
 * of GFM-specific bits, so the additions are deliberately narrow — widening the
 * tag list would be the easy way to reintroduce script execution.
 *
 * - `input` + `type`/`checked`/`disabled` — GFM task lists render as disabled
 *   checkboxes. `input` is allowed by default but the attributes are worth
 *   pinning so a DOMPurify update can't silently empty out every task list.
 * - `align` — GFM's `|:---:|` column alignment lands as an attribute on th/td.
 *
 * Everything dangerous stays off: no `ALLOWED_TAGS` override, so script/iframe/
 * object are still dropped, and DOMPurify strips every `on*` handler and
 * javascript: URL regardless of what we add here.
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
