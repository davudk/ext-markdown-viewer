/**
 * The alert callout, in the one place both spellings of it can reach.
 *
 * `> [!NOTE]` and `:::note` are the same block written twice by two ecosystems,
 * and the viewer renders them identically — same class prefix, same icon, one
 * block of CSS. That shared shape is now split across two plugins
 * (`markdown-github-alerts` and `markdown-containers`), which may not import
 * each other, so the markup they have in common lives here rather than being
 * copied into both and drifting.
 */

import { ALERT_CLASS_PREFIX, type AlertKind } from './config.ts';
import { escapeHtml } from './escape.ts';

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
 *
 * They are inline `<svg>`, which is the whole reason `PURIFY_CONFIG` enables
 * the SVG profile. Nothing here needs it widened any further.
 */
export const ALERT_ICONS: Record<AlertKind, string> = {
  note: `<svg ${ICON_ATTRS}><circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v4.1M8 4.7v.1"/></svg>`,
  tip: `<svg ${ICON_ATTRS}><path d="M8 1.7a4.3 4.3 0 0 0-2.6 7.7c.4.4.7.9.7 1.4h3.8c0-.5.3-1 .7-1.4A4.3 4.3 0 0 0 8 1.7Z"/><path d="M6.4 13.1h3.2M6.9 14.9h2.2"/></svg>`,
  important: `<svg ${ICON_ATTRS}><path d="M1.9 3.2a1.3 1.3 0 0 1 1.3-1.3h9.6a1.3 1.3 0 0 1 1.3 1.3v7.2a1.3 1.3 0 0 1-1.3 1.3H7.4l-3.2 2.7v-2.7H3.2a1.3 1.3 0 0 1-1.3-1.3Z"/><path d="M8 4.6v3.1M8 9.6v.1"/></svg>`,
  warning: `<svg ${ICON_ATTRS}><path d="M7.1 2.4 1.6 12.5a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.4a1 1 0 0 0-1.8 0Z"/><path d="M8 6.2v3.1M8 11.4v.1"/></svg>`,
  caution: `<svg ${ICON_ATTRS}><path d="M5.4 1.7h5.2l3.7 3.7v5.2l-3.7 3.7H5.4l-3.7-3.7V5.4Z"/><path d="M8 4.7v3.4M8 10.9v.1"/></svg>`,
};

/** The opening half of a callout: the wrapper and its titled, iconed heading. */
export function alertOpen(kind: AlertKind, title: string): string {
  const prefix = ALERT_CLASS_PREFIX;
  return (
    `<div class="${prefix} ${prefix}-${kind}">` +
    `<p class="${prefix}-title">${ALERT_ICONS[kind]}${escapeHtml(title)}</p>`
  );
}
