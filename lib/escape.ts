/**
 * HTML escaping, in its own module for one reason: everything that needs it.
 *
 * `lib/markdown.ts`, `lib/alerts.ts`, `lib/export.ts` and four markdown plugins
 * all escape untrusted text. Leaving it exported from `lib/markdown.ts` — where
 * it lived — would make every plugin import the module that imports the
 * plugins, which is a cycle the bare node runner resolves by handing one side
 * an empty namespace. It is re-exported from `lib/markdown.ts` so existing
 * callers do not have to care.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
