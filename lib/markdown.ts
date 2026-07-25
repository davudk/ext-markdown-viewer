/**
 * The markdown → sanitized HTML pipeline. Configuration for both halves lives
 * in `config.ts`; this file is only the wiring and the failure handling.
 */

import DOMPurify from 'dompurify';
// The ~40-language "common" bundle. The full build pulls in ~190 grammars and
// dwarfs the rest of the extension, and the extras are languages nobody puts in
// a README.
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

import {
  HIGHLIGHT_EMPTY_LANG_CLASS,
  HIGHLIGHT_LANG_PREFIX,
  MARKED_OPTIONS,
  PURIFY_CONFIG,
} from './config.ts';

const marked = new Marked(
  markedHighlight({
    langPrefix: HIGHLIGHT_LANG_PREFIX,
    emptyLangClass: HIGHLIGHT_EMPTY_LANG_CLASS,

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
  MARKED_OPTIONS,
);

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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
