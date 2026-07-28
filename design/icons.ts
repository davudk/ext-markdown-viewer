/**
 * The icon set, as strings.
 *
 * Decision D9 in docs/design-system.md. Inline SVG is right for this extension
 * — it never loads a resource of any kind — but the same `<svg …>` prelude had
 * been copy-pasted into four files, which is how the set drifted to five sizes
 * and two stroke widths. One module holds the prelude and each glyph once.
 *
 * Strings rather than a component, because half the callers build their markup
 * as template literals in add-ons injected into the page, where a React
 * component is unusable. A string composes in both worlds: template literals
 * here, `dangerouslySetInnerHTML` on a span over there.
 *
 * Two sizes, matching `--mdv-icon-sm` / `--mdv-icon-md` in tokens.css. The
 * width/height are baked into the markup rather than left to CSS because these
 * glyphs are cloned into pages whose stylesheet load order is not guaranteed;
 * an icon that is briefly 300px wide is worse than one that cannot be themed.
 */

/** 13px (`--mdv-icon-sm`) and 15px (`--mdv-icon-md`). Nothing in between. */
export type IconSize = 13 | 15;

/**
 * The shared prelude: everything the four copies had in common, unchanged.
 * `className` is omitted entirely when not given — the add-on surfaces style
 * their controls by descendant selector and want no class here.
 */
export function svgIcon(size: IconSize, paths: string, className?: string): string {
  const cls = className === undefined ? '' : ` class="${className}"`;
  return [
    `<svg${cls} viewBox="0 0 16 16" width="${size}" height="${size}" fill="none"`,
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"',
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`,
  ].join(' ');
}

/* -------------------------------------------------------------------------- */
/* Glyphs — path data only, so a caller picks the size and class it needs.      */
/* -------------------------------------------------------------------------- */

/** Copy: the two overlapping sheets. */
export const COPY_PATHS =
  '<rect x="5.2" y="5.2" width="8.8" height="8.8" rx="1.4"/><path d="M10.8 5V3.4A1.4 1.4 0 0 0 9.4 2H3.4A1.4 1.4 0 0 0 2 3.4v6a1.4 1.4 0 0 0 1.4 1.4H5"/>';

/** Check: the confirmation face shared by every copy-shaped control. */
export const CHECK_PATHS = '<path d="m3 8.4 3.2 3.3L13 4.6"/>';

/** Alert: the failure face those same controls fall back to. */
export const FAIL_PATHS =
  '<circle cx="8" cy="8" r="6.1"/><path d="M8 4.9v3.6M8 10.8v.1"/>';

/** Link: the heading anchor's idle face. */
export const LINK_PATHS =
  '<path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l2.1-2.1a2.9 2.9 0 0 0-4.1-4.1l-1 1"/><path d="M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.2 8.7a2.9 2.9 0 0 0 4.1 4.1l1-1"/>';

/**
 * The sort indicator's three states. The unsorted face carries its own class
 * because the stylesheet fills it rather than stroking it — the one glyph in
 * the set that is a solid shape.
 */
export const SORT_NONE_PATHS = '<path class="mdv-sort-up" d="M8 10.5 4.5 6.5h7z"/>';
export const SORT_ASC_PATHS = '<path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5"/>';
export const SORT_DESC_PATHS = '<path d="M8 3.5V12M4.5 8.5 8 12l3.5-3.5"/>';

/** The diagram viewer's controls. */
export const ZOOM_IN_PATHS =
  '<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14M7 5.2v3.6M5.2 7h3.6"/>';
export const ZOOM_OUT_PATHS =
  '<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14M5.2 7h3.6"/>';
export const RESET_PATHS =
  '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2.4v2.9h-2.9"/>';
export const FULLSCREEN_PATHS =
  '<path d="M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10"/>';
export const DOWNLOAD_SVG_PATHS =
  '<path d="M8 2.4v7.4M5.2 7l2.8 2.8L10.8 7M2.8 12.2v1.4h10.4v-1.4"/>';
export const DOWNLOAD_PNG_PATHS =
  '<rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.4"/><circle cx="5.8" cy="6.4" r="1"/><path d="m2.8 11 3.4-3.1 3 2.6 2-1.7 2.2 2"/>';

/* -------------------------------------------------------------------------- */
/* Ready-made icons                                                            */
/*                                                                             */
/* The sizes and classes the surfaces actually use, resolved once so no caller  */
/* repeats a size decision. Anything needing another pairing calls svgIcon.     */
/* -------------------------------------------------------------------------- */

/** Viewer-chrome icons: 13px, and `.mdv-icon` for the shared block/flex reset. */
export const ICON_COPY = svgIcon(13, COPY_PATHS, 'mdv-icon');
export const ICON_CHECK = svgIcon(13, CHECK_PATHS, 'mdv-icon');
export const ICON_FAIL = svgIcon(13, FAIL_PATHS, 'mdv-icon');
export const ICON_LINK = svgIcon(13, LINK_PATHS, 'mdv-icon');

/** Sort indicators: 13px (up from 11px, which was below the scale). */
export const ICON_SORT_NONE = svgIcon(13, SORT_NONE_PATHS, 'mdv-sort-icon');
export const ICON_SORT_ASC = svgIcon(13, SORT_ASC_PATHS, 'mdv-sort-icon');
export const ICON_SORT_DESC = svgIcon(13, SORT_DESC_PATHS, 'mdv-sort-icon');

/** Diagram controls: 13px, unclassed — the add-on styles them by descent. */
export const ICON_ZOOM_IN = svgIcon(13, ZOOM_IN_PATHS);
export const ICON_ZOOM_OUT = svgIcon(13, ZOOM_OUT_PATHS);
export const ICON_RESET = svgIcon(13, RESET_PATHS);
export const ICON_FULLSCREEN = svgIcon(13, FULLSCREEN_PATHS);
export const ICON_DOWNLOAD_SVG = svgIcon(13, DOWNLOAD_SVG_PATHS);
export const ICON_DOWNLOAD_PNG = svgIcon(13, DOWNLOAD_PNG_PATHS);
