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

export interface Settings {
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
};

/** The single chrome.storage.local key everything is stored under. */
export const SETTINGS_KEY = 'settings';

/** Theme choices, in the order they are presented. */
export const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

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
