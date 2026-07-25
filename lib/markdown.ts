import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const marked = new Marked({
  async: false,
  gfm: true,
  breaks: false,
});

/**
 * The source is untrusted — any site can serve a .md file containing raw HTML,
 * and marked passes that through by design. Sanitize before it reaches the DOM.
 */
export function renderMarkdown(source: string): string {
  const raw = marked.parse(source) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}
