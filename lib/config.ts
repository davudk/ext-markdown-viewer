/**
 * Every static value in the extension: activation rules, defaults, shared
 * identifiers, and library configuration.
 *
 * The split this file enforces is data here, behaviour everywhere else. Adding
 * a supported extension, allowing another host, or introducing a new setting
 * should be an edit to this file alone — if it also requires touching logic,
 * the logic is probably over-specific and worth reworking instead.
 *
 * Nothing here imports from the rest of the codebase, so it can be pulled into
 * any context (service worker, content script, extension page, node test) with
 * no risk of a cycle.
 */

import type { Config as PurifyConfig } from 'dompurify';
import type { MarkedExtension } from 'marked';

/* -------------------------------------------------------------------------- */
/* Activation                                                                  */
/* -------------------------------------------------------------------------- */

/** File extensions treated as markdown. Order is not significant. */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mkd', '.mdx'];

/** Content types a markdown file plausibly arrives as. */
export const MARKDOWN_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
];

/** URL schemes the extension can act on at all. */
export const SUPPORTED_PROTOCOLS = ['http:', 'https:', 'file:'];

/**
 * Hosts that render markdown themselves. Most serve text/html and would be
 * filtered by the content-type check anyway, but they're listed explicitly so
 * a redesign on their end can't turn us into a page-wrecking bug.
 */
export const RENDERS_ITS_OWN_MARKDOWN = [
  'github.com',
  'gist.github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'gitbook.io',
  'gitbook.com',
  'readthedocs.io',
  'readthedocs.org',
  'readme.io',
  'notion.so',
  'obsidian.md',
];

/** Raw-content hosts, which serve markdown as text and are always fair game. */
export const RAW_HOSTS = [
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'raw.githack.com',
  'cdn.jsdelivr.net',
];

/** Browser-internal pages where no extension may run, whatever the URL says. */
export const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'edge:',
  'brave:',
  'about:',
  'devtools:',
  'view-source:',
  'chrome-extension:',
  'moz-extension:',
];

/* -------------------------------------------------------------------------- */
/* DOM contract                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The element the renderer mounts into. Also the marker for "this tab has
 * already been taken over", which the popup checks — so it is shared, not a
 * private detail of the renderer.
 */
export const VIEWER_ROOT_ID = 'mdv-root';

/** `data-mdv-theme` on <html>, in the dataset camelCase form. Keyed on by viewer.css. */
export const VIEWER_THEME_DATASET_KEY = 'mdvTheme';

/**
 * CSS custom properties the viewer sets from settings. Declared here so the
 * stylesheet and the code that writes them cannot drift apart.
 */
export const VIEWER_CSS_VARS = {
  fontFamily: '--mdv-font-body',
  fontSize: '--mdv-font-size',
  lineHeight: '--mdv-line-height',
  contentWidth: '--mdv-measure',
} as const;

/** Heading levels that get an id, an anchor link, and a table-of-contents entry. */
export const TOC_LEVELS = [1, 2, 3, 4];

/**
 * Keyboard shortcuts, as `KeyboardEvent.key` values matched case-insensitively.
 * Deliberately unmodified single keys: the viewer owns the whole page, and
 * anything with a modifier risks colliding with a browser shortcut.
 */
export const SHORTCUTS = {
  toggleToc: 't',
  toggleRaw: 'r',
  cycleTheme: 'd',
} as const;

/* -------------------------------------------------------------------------- */
/* Build output                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Injected by path via chrome.scripting, so these are the *emitted* filenames,
 * not the source ones: WXT puts CSS entrypoints under `assets/` while scripts
 * land at the root. `scripts/check-build.mjs` asserts both exist in the built
 * extension, because a wrong path here fails only at runtime.
 */
export const RENDERER_JS = 'renderer.js';
export const RENDERER_CSS = 'assets/viewer.css';

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/** Requesting this is what "render automatically on every site" actually means. */
export const ALL_SITES = '*://*/*';

/**
 * A single stable id for everything we register. Registrations are always
 * rebuilt wholesale from granted permissions, so there is never more than one.
 */
export const CONTENT_SCRIPT_ID = 'markdown-auto';

/** Permissions declared in the manifest, asserted against the build output. */
export const REQUIRED_PERMISSIONS = ['storage', 'activeTab', 'scripting'];

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export type Theme = 'light' | 'dark' | 'auto';
export type FontFamily = 'system' | 'serif' | 'mono';
export type ContentWidth = 'narrow' | 'normal' | 'wide' | 'full';

export interface Settings {
  theme: Theme;
  fontFamily: FontFamily;
  /** Base font size in px. Clamped to FONT_SIZE_RANGE on write. */
  fontSize: number;
  lineHeight: number;
  contentWidth: ContentWidth;
  /** Whether the table-of-contents sidebar is shown at all. */
  showToc: boolean;
  /**
   * Re-read the open document when the underlying file changes.
   *
   * Off by default, and the only setting that is. Detecting a change means
   * re-requesting the document's own address — the sole request the extension
   * can ever make — so it stays something the user turns on deliberately rather
   * than something they would have to discover and turn off.
   */
  liveReload: boolean;
  /** Restore the previous scroll position when reopening a document. */
  rememberScroll: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.65,
  contentWidth: 'normal',
  showToc: true,
  liveReload: false,
  rememberScroll: true,
};

/**
 * Modules permitted to call `fetch`. Enforced against the source tree by
 * `scripts/audit-network.mjs`, so a request appearing anywhere else fails the
 * build rather than being noticed in review.
 */
export const FETCH_ALLOWLIST = ['lib/hooks.ts'];

/** The single chrome.storage.local key settings are stored under. */
export const SETTINGS_KEY = 'settings';

/** Per-document state (scroll position), kept apart so it can be cleared alone. */
export const DOCUMENT_STATE_KEY = 'documents';

/** How many documents' positions to remember before evicting the oldest. */
export const DOCUMENT_STATE_LIMIT = 200;

interface Option<T> {
  value: T;
  label: string;
}

/** Theme choices, in the order they are presented. */
export const THEME_OPTIONS: ReadonlyArray<Option<Theme>> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

export const FONT_FAMILY_OPTIONS: ReadonlyArray<Option<FontFamily>> = [
  { value: 'system', label: 'Sans' },
  { value: 'serif', label: 'Serif' },
  { value: 'mono', label: 'Mono' },
];

/**
 * Widths in `ch`, so the measure tracks the chosen font size rather than
 * drifting from it. `full` opts out of the cap entirely.
 */
export const CONTENT_WIDTH_OPTIONS: ReadonlyArray<Option<ContentWidth>> = [
  { value: 'narrow', label: 'Narrow' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' },
];

export const CONTENT_WIDTH_CH: Record<ContentWidth, string> = {
  narrow: '58ch',
  normal: '72ch',
  wide: '90ch',
  full: 'none',
};

export const FONT_SIZE_RANGE = { min: 12, max: 24, step: 1 };
export const LINE_HEIGHT_RANGE = { min: 1.3, max: 2.1, step: 0.05 };

/** Font stacks. System only — a webfont URL would break the zero-network guarantee. */
export const FONT_STACKS: Record<FontFamily, string> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', ui-sans-serif, system-ui, sans-serif",
  serif:
    "'Iowan Old Style', 'Palatino Linotype', Palatino, Charter, 'Bitstream Charter', Georgia, ui-serif, serif",
  mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
};

/* -------------------------------------------------------------------------- */
/* Markdown pipeline                                                           */
/* -------------------------------------------------------------------------- */

/** Typed as an extension because that is what the `Marked` constructor accepts. */
export const MARKED_OPTIONS: MarkedExtension = {
  async: false,
  gfm: true,
  breaks: false,
};

/**
 * marked-highlight appends the language tag to this, so the emitted class is
 * `hljs language-ts` — the stylesheet keys off the `hljs` class and the token
 * spans, so both parts have to be there.
 */
export const HIGHLIGHT_LANG_PREFIX = 'hljs language-';
export const HIGHLIGHT_EMPTY_LANG_CLASS = 'hljs';

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
export const PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ['align', 'type', 'checked', 'disabled'],
  // Nothing in markdown output needs data-*; dropping them shrinks the surface
  // for attribute-based gadgets in whatever consumes the DOM later.
  ALLOW_DATA_ATTR: false,
  // A stylesheet from an untrusted .md could reposition or hide our own UI.
  FORBID_TAGS: ['style'],
};
