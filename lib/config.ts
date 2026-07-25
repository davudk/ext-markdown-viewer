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

import type { MarkdownKatexOptions } from '@vscode/markdown-it-katex';
import type { Config as PurifyConfig } from 'dompurify';
import type { KatexOptions } from 'katex';
import type { Options as MarkdownItOptions } from 'markdown-it';

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
  /** Also bound to ctrl/cmd+F, which the search panel takes over deliberately. */
  search: '/',
} as const;

/** Export formats. Both are produced client-side; nothing is uploaded. */
export const EXPORT_FORMATS = [
  { value: 'html', label: 'HTML', extension: '.html' },
  { value: 'docx', label: 'Word', extension: '.docx' },
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number]['value'];

/** How many search matches to mark before giving up on a pathological query. */
export const SEARCH_MATCH_LIMIT = 2000;

/**
 * Reading speed for whitespace-delimited prose, in words per minute.
 *
 * Middling silent-reading rates for adults land between 200 and 260 wpm on
 * ordinary text; documentation sits at the slower end of that, so this is
 * deliberately not the flattering number.
 */
export const READING_WORDS_PER_MINUTE = 220;

/**
 * Reading speed for CJK text, in *characters* per minute.
 *
 * A separate rate because a Chinese, Japanese or Korean character carries far
 * more than a Latin one — timing them at the same rate as words would report a
 * page of Chinese as a ten-second read.
 */
export const READING_CJK_PER_MINUTE = 480;

/**
 * Heading levels that get a fold control.
 *
 * All six rather than `TOC_LEVELS`: an `h5` still owns the paragraphs under it,
 * and a section that cannot be collapsed because it is too deep to appear in
 * the sidebar would be arbitrary.
 */
export const FOLD_LEVELS = [1, 2, 3, 4, 5, 6];

/* -------------------------------------------------------------------------- */
/* Sidebar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The sidebar's tabs, in the order they are presented.
 *
 * Only the identity and the label live here; `Sidebar.tsx` maps each id to the
 * component that draws it. Adding a tab is an entry here plus a line in that
 * map — deliberately, because a third one (Search) is already planned.
 */
export const SIDEBAR_TABS = [
  { id: 'outline', label: 'Outline' },
  { id: 'files', label: 'Files' },
] as const;

export type SidebarTabId = (typeof SIDEBAR_TABS)[number]['id'];

export const DEFAULT_SIDEBAR_TAB: SidebarTabId = 'outline';

/** Sidebar UI state (which tab is open), kept out of `Settings` — it is not a preference. */
export const SIDEBAR_STATE_KEY = 'sidebar';

/* -------------------------------------------------------------------------- */
/* Folder browser                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Directories never listed, whatever they contain. Dotted names are excluded by
 * rule rather than by list; these two are the ones that are not dotted and are
 * large enough that expanding one is indistinguishable from a hang.
 */
export const FOLDER_SKIP_DIRECTORIES = ['node_modules', '.git'];

/**
 * Entries kept from a single directory. A generated output folder can hold tens
 * of thousands of files, and the cost is not the read — it is the rows. The
 * browser reports the overflow rather than pretending the directory ends here.
 */
export const FOLDER_ENTRY_LIMIT = 500;

/**
 * Where a picked directory handle is kept.
 *
 * IndexedDB, because a `FileSystemDirectoryHandle` is structured-cloneable but
 * not JSON — chrome.storage cannot hold one. See `lib/folder.ts` for what this
 * does and does not survive; the short version is that a content script writes
 * under the *page's* origin, so this is per-origin storage, not per-extension.
 */
export const FOLDER_DB_NAME = 'mdv-folder';
export const FOLDER_STORE_NAME = 'handles';
export const FOLDER_HANDLE_KEY = 'current';

/**
 * Identity scheme for a document read through a directory handle rather than
 * fetched from an address.
 *
 * Deliberately absent from `SUPPORTED_PROTOCOLS`: such a document has no URL to
 * re-request, so live reload must decline it rather than poll the page it
 * replaced. `documentKey()` still parses it, so scroll memory keeps working and
 * each file in the folder gets its own entry.
 */
export const FOLDER_DOCUMENT_SCHEME = 'mdv-folder:';

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

/**
 * Every stylesheet the renderer needs, in cascade order.
 *
 * There are two because they arrive by different routes: `viewer.css` is a CSS
 * entrypoint, while `renderer.css` is what Vite emits for the stylesheets the
 * React components import. Missing the second one costs no build error and no
 * type error — the document simply renders with its chrome unstyled — so
 * `scripts/check-build.mjs` asserts that no emitted stylesheet is left
 * unreachable.
 */
export const RENDERER_CSS_FILES = ['assets/viewer.css', 'assets/renderer.css'];

/**
 * Heavy features, injected only into documents that actually use them.
 *
 * Mermaid alone is larger than everything else in the extension combined, and
 * most markdown contains no diagrams at all. Rather than pay that on every
 * page, the renderer detects the relevant blocks and asks the service worker to
 * inject the matching add-on — the same `chrome.scripting` path the popup
 * already uses, so no dynamic `import()` and no web-accessible chunks are
 * involved.
 *
 * Each add-on operates on the DOM directly; it is not part of the React tree.
 */
export const ADDONS = {
  mermaid: { js: 'mermaid-addon.js', css: [] as string[] },
  // The stylesheet cannot be named `katex-addon.css`: WXT treats every file in
  // entrypoints/ as an entrypoint and refuses two with the same base name.
  katex: { js: 'katex-addon.js', css: ['assets/katex-theme.css'] },
} as const;

export type AddonName = keyof typeof ADDONS;

/** Marks a code block the mermaid add-on should replace with a diagram. */
export const MERMAID_LANGUAGE = 'mermaid';

/** Class the KaTeX extension puts on math it has rendered. */
export const MATH_CLASS = 'katex';

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

/**
 * Permissions declared in the manifest, asserted against the build output.
 *
 * `downloads` arrives with export: saving an HTML or DOCX file is the only
 * thing that needs it, and it was deliberately left out until then.
 */
export const REQUIRED_PERMISSIONS = [
  'storage',
  'activeTab',
  'scripting',
  'downloads',
];

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export type Theme = 'light' | 'dark' | 'auto';
export type FontFamily = 'system' | 'serif' | 'mono';
export type ContentWidth = 'narrow' | 'normal' | 'wide' | 'full';

/**
 * Where presentation mode cuts one slide from the next.
 *
 * `auto` prefers `rule` and falls back to `heading`; see SLIDE_SPLIT_OPTIONS.
 */
export type SlideSplit = 'auto' | 'rule' | 'heading';

export interface Settings {
  theme: Theme;
  /**
   * Which colour family the viewer draws in. Orthogonal to `theme`: the preset
   * chooses the palette, `theme` still chooses which half of it is used.
   */
  themePreset: ThemePresetId;
  /**
   * A stylesheet the reader wrote, applied to rendered documents only. Stored
   * verbatim so the editor round-trips what was typed; every path that applies
   * it goes through `sanitizeCustomCss` first.
   */
  customCss: string;
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
  /** Render ```mermaid blocks as diagrams. Costs an on-demand add-on injection. */
  mermaid: boolean;
  /** Render $inline$ and $$block$$ math with KaTeX. */
  math: boolean;
  /** Click an image to open it full-size with keyboard navigation. */
  lightbox: boolean;
  /**
   * Mark links that leave the document with a small trailing indicator.
   *
   * Derived from the URL and the document's own address, never from a request:
   * asking each host whether it exists would hand every one of them the fact
   * that this document was opened.
   */
  externalLinks: boolean;
  /** Offer presentation mode on rendered documents. */
  presentation: boolean;
  /** Where presentation mode cuts slides. */
  slideSplit: SlideSplit;
  /**
   * Word count and reading time for the open document.
   *
   * Counted from the rendered text with code blocks left out; see
   * `lib/reading.ts` for what that means and why.
   */
  readingStats: boolean;
  /** A thin bar tracking how far through the document the reader has scrolled. */
  readingProgress: boolean;
  /**
   * A fold control on every heading, collapsing the section under it.
   *
   * On by default even though it puts a control on every heading: the control
   * is muted until the heading is approached, and a folding feature nobody can
   * see is a folding feature nobody uses. Fold state is per-session — see
   * `components/HeadingFold.tsx` for why it is deliberately not persisted.
   */
  headingFold: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  themePreset: 'default',
  customCss: '',
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.65,
  contentWidth: 'normal',
  showToc: true,
  liveReload: false,
  rememberScroll: true,
  mermaid: true,
  math: true,
  lightbox: true,
  externalLinks: true,
  presentation: true,
  slideSplit: 'auto',
  readingStats: true,
  readingProgress: true,
  headingFold: true,
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

/**
 * Per-document theme pins, kept apart from both settings and scroll memory for
 * the same reason those two are apart: "unpin every document" must not be able
 * to take a preference or a reading position with it.
 */
export const DOCUMENT_THEME_KEY = 'documentThemes';

/**
 * Lower than DOCUMENT_STATE_LIMIT on purpose. A scroll position is written for
 * every document that is opened; a theme pin only exists because someone chose
 * it, so the list is both far shorter in practice and one the user is expected
 * to be able to read through on the options page.
 */
export const DOCUMENT_THEME_LIMIT = 50;

/** Longest user stylesheet accepted, in characters. */
export const CUSTOM_CSS_MAX_LENGTH = 20_000;

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

/**
 * How presentation mode is told where one slide ends.
 *
 * `rule` is the convention every markdown presenter already uses — Marp,
 * reveal.js, remark, Deckset and Pandoc all cut on `---` — and it is the only
 * one that is *authored*: the writer put the break exactly where they wanted
 * it. Heading splitting is a heuristic imposed on a document that was never
 * written as a deck, which is why it is not the default on its own.
 *
 * It is also why the default is neither: almost no README carries a single
 * `---`, and presenting one as a single wall of text is a worse answer than
 * cutting at its section headings. `auto` takes the author's breaks when there
 * are any and falls back to the outline when there are none.
 */
export const SLIDE_SPLIT_OPTIONS: ReadonlyArray<Option<SlideSplit>> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'rule', label: 'Horizontal rules' },
  { value: 'heading', label: 'Headings' },
];

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
/* Theme presets                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every colour token `entrypoints/viewer.css` declares under
 * `:root[data-mdv-theme='light'|'dark']`, minus the `--mdv-` prefix.
 *
 * A preset must supply all of them. Supplying a subset is the failure that
 * looks like a bug rather than a missing feature: the document takes the new
 * palette and the code blocks keep the old one, so `test/theme-presets.test.ts`
 * asserts every palette covers this list exactly.
 */
export const THEME_TOKENS = [
  'bg',
  'surface',
  'surface-alt',
  'fg',
  'fg-muted',
  'border',
  'border-strong',
  'accent',
  'accent-hover',
  'visited',
  'on-accent',
  'selection',
  'scrollbar',
  'mark-bg',
  'tk-keyword',
  'tk-string',
  'tk-comment',
  'tk-number',
  'tk-title',
  'tk-builtin',
  'tk-tag',
  'tk-meta',
  'tk-punct',
  'tk-addition',
  'tk-addition-bg',
  'tk-deletion',
  'tk-deletion-bg',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** Every value is an opaque `#rrggbb`, so contrast is computable without a browser. */
export type ThemePalette = Record<ThemeToken, string>;

export interface ThemePreset {
  id: string;
  label: string;
  /** One line under the name in the picker. */
  note: string;
  /**
   * Both halves, always. A preset selects the colour family; the `theme`
   * setting still selects the polarity, so `light`, `dark` and `auto` keep
   * meaning exactly what they meant before a preset was chosen.
   */
  light: ThemePalette;
  dark: ThemePalette;
}

/**
 * The built-in palettes.
 *
 * Two rules shaped every value here, and neither is taste:
 *
 *   Contrast is a correctness property. Body text, muted text, links and every
 *   syntax token clear WCAG AA (4.5:1) against the surface they are actually
 *   drawn on — the page for prose, `surface` for code blocks, the diff
 *   backgrounds for additions and deletions. `high-contrast` clears AAA (7:1).
 *   The ratios are computed, not judged: `test/theme-presets.test.ts` recomputes
 *   all of them on every run, so a preset added later cannot ship failing.
 *
 *   That is also why the borrowed palettes are not verbatim. Solarized, Nord and
 *   Gruvbox were all designed against a lower bar, and several of their accents
 *   land near 3:1 on their own backgrounds. Hue and character are kept; the
 *   lightness of a failing colour is moved until it passes. Where a family ships
 *   only one polarity (Nord is a dark theme), the other half is built from the
 *   same named palette rather than invented — Nord's own Snow Storm greys.
 */
export const THEME_PRESETS = [
  {
    id: 'default',
    label: 'Default',
    note: "The viewer's own palette.",
    // Mirrors the tokens in entrypoints/viewer.css. Duplicated rather than
    // parsed out of the sheet for the same reason EXPORT_CSS is: the test
    // runner is bare node and cannot import a stylesheet. The duplication is
    // load-bearing in one direction only — these values are what the contrast
    // test actually checks, so the default palette is held to the same bar as
    // every preset instead of being grandfathered in.
    light: {
      bg: '#ffffff',
      surface: '#f6f8fa',
      'surface-alt': '#fafbfc',
      fg: '#1f2328',
      'fg-muted': '#5a636d',
      border: '#d5dbe1',
      'border-strong': '#b6bfc9',
      accent: '#0a53be',
      'accent-hover': '#08409a',
      visited: '#6639ba',
      'on-accent': '#ffffff',
      selection: '#cfe3ff',
      scrollbar: '#c3ccd5',
      'mark-bg': '#fff3c4',
      'tk-keyword': '#b3202c',
      'tk-string': '#0a3069',
      'tk-comment': '#5f6874',
      'tk-number': '#0550ae',
      'tk-title': '#7a3fd0',
      'tk-builtin': '#8a3400',
      'tk-tag': '#0f5c28',
      'tk-meta': '#57606a',
      'tk-punct': '#4a545e',
      'tk-addition': '#0f5c28',
      'tk-addition-bg': '#e6ffec',
      'tk-deletion': '#8a1420',
      'tk-deletion-bg': '#ffebe9',
    },
    dark: {
      bg: '#0d1117',
      surface: '#161b22',
      'surface-alt': '#12171f',
      fg: '#e6edf3',
      'fg-muted': '#9aa4af',
      border: '#30363d',
      'border-strong': '#4a525c',
      accent: '#6cb1ff',
      'accent-hover': '#8cc4ff',
      visited: '#c4a0ff',
      'on-accent': '#0d1117',
      selection: '#2d4f7c',
      scrollbar: '#454d57',
      'mark-bg': '#4a3a12',
      'tk-keyword': '#ff8a80',
      'tk-string': '#a8d5ff',
      'tk-comment': '#9aa4af',
      'tk-number': '#84c5ff',
      'tk-title': '#d7b3ff',
      'tk-builtin': '#ffb070',
      'tk-tag': '#8ceb96',
      'tk-meta': '#a5b1bd',
      'tk-punct': '#c2cbd4',
      'tk-addition': '#8ceb96',
      'tk-addition-bg': '#10251a',
      'tk-deletion': '#ffaba4',
      'tk-deletion-bg': '#2b1416',
    },
  },
  {
    id: 'solarized',
    label: 'Solarized',
    note: 'Warm paper and deep teal, after Ethan Schoonover.',
    light: {
      bg: '#fdf6e3',
      surface: '#f4ecd6',
      'surface-alt': '#f9f2e0',
      fg: '#073642',
      'fg-muted': '#4a5f66',
      border: '#ded5bd',
      'border-strong': '#bcb49e',
      accent: '#1a5f8a',
      'accent-hover': '#124765',
      visited: '#5a4fa8',
      'on-accent': '#fdf6e3',
      selection: '#dee7cf',
      scrollbar: '#c8c0aa',
      'mark-bg': '#f2e2a8',
      'tk-keyword': '#9c1f1c',
      'tk-string': '#1a6b64',
      'tk-comment': '#5a6e73',
      'tk-number': '#1a5f8a',
      'tk-title': '#5a4fa8',
      'tk-builtin': '#8f3510',
      'tk-tag': '#5b6600',
      'tk-meta': '#5c6e74',
      'tk-punct': '#44565c',
      'tk-addition': '#4a5b00',
      'tk-addition-bg': '#e8eccd',
      'tk-deletion': '#9c1f1c',
      'tk-deletion-bg': '#f7e0d8',
    },
    dark: {
      bg: '#002b36',
      surface: '#073642',
      'surface-alt': '#04303b',
      fg: '#e3ddc9',
      'fg-muted': '#a3b0ae',
      border: '#134653',
      'border-strong': '#2c5f6c',
      accent: '#5fb4e5',
      'accent-hover': '#86c9ef',
      visited: '#a9adea',
      'on-accent': '#002b36',
      selection: '#0f4a58',
      scrollbar: '#2f5f6b',
      'mark-bg': '#5a4a12',
      'tk-keyword': '#f5726f',
      'tk-string': '#4fc7bb',
      'tk-comment': '#93a1a1',
      'tk-number': '#5fb4e5',
      'tk-title': '#a9adea',
      'tk-builtin': '#f2803f',
      'tk-tag': '#a4bd28',
      'tk-meta': '#9aa9a8',
      'tk-punct': '#b9c2bd',
      'tk-addition': '#a4bd28',
      'tk-addition-bg': '#123321',
      'tk-deletion': '#f5726f',
      'tk-deletion-bg': '#3a1a1c',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    note: 'Arctic blue-greys. The light half uses Nord’s own Snow Storm.',
    light: {
      bg: '#eceff4',
      surface: '#e2e7ee',
      'surface-alt': '#e8ecf2',
      fg: '#2e3440',
      'fg-muted': '#4c566a',
      border: '#d2d9e3',
      'border-strong': '#aeb8c8',
      accent: '#2b6584',
      'accent-hover': '#1f4d66',
      visited: '#7a4b7d',
      'on-accent': '#eceff4',
      selection: '#d3dbe6',
      scrollbar: '#b9c2d0',
      'mark-bg': '#ecdcb0',
      'tk-keyword': '#58668f',
      'tk-string': '#4a6a3e',
      'tk-comment': '#5b6478',
      'tk-number': '#2b6584',
      'tk-title': '#2f6b7c',
      'tk-builtin': '#8a5320',
      'tk-tag': '#4a6a3e',
      'tk-meta': '#5b6478',
      'tk-punct': '#414c5e',
      'tk-addition': '#3f6a3a',
      'tk-addition-bg': '#dfe9d8',
      'tk-deletion': '#9d3a3a',
      'tk-deletion-bg': '#f0dcdc',
    },
    dark: {
      bg: '#2e3440',
      surface: '#3b4252',
      'surface-alt': '#343b49',
      fg: '#eceff4',
      'fg-muted': '#b5bfd0',
      border: '#434c5e',
      'border-strong': '#5a657c',
      accent: '#88c0d0',
      'accent-hover': '#a3d2df',
      visited: '#c9a3cd',
      'on-accent': '#2e3440',
      selection: '#4c566a',
      scrollbar: '#59637a',
      'mark-bg': '#5c5230',
      'tk-keyword': '#9fb0dd',
      'tk-string': '#a3be8c',
      'tk-comment': '#a4aec0',
      'tk-number': '#c3a5bd',
      'tk-title': '#88c0d0',
      'tk-builtin': '#ebcb8b',
      'tk-tag': '#8fbcbb',
      'tk-meta': '#aab4c6',
      'tk-punct': '#d8dee9',
      'tk-addition': '#a3be8c',
      'tk-addition-bg': '#333f34',
      'tk-deletion': '#e08b86',
      'tk-deletion-bg': '#453236',
    },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    note: 'Retro, low-saturation, high warmth.',
    light: {
      bg: '#fbf1c7',
      surface: '#f2e5bc',
      'surface-alt': '#f7ebc4',
      fg: '#3c3836',
      'fg-muted': '#5c5147',
      border: '#e4d5a8',
      'border-strong': '#bdae87',
      accent: '#076678',
      'accent-hover': '#054b58',
      visited: '#8f3f71',
      'on-accent': '#fbf1c7',
      selection: '#e6dcae',
      scrollbar: '#c8b98f',
      'mark-bg': '#efd88a',
      'tk-keyword': '#9d0006',
      'tk-string': '#5f6300',
      'tk-comment': '#6b6054',
      'tk-number': '#8f3f71',
      'tk-title': '#076678',
      'tk-builtin': '#8f4508',
      'tk-tag': '#3d7151',
      'tk-meta': '#6b6054',
      'tk-punct': '#4a4340',
      'tk-addition': '#4f6a2f',
      'tk-addition-bg': '#e6e6b0',
      'tk-deletion': '#9d0006',
      'tk-deletion-bg': '#f3d9c0',
    },
    dark: {
      bg: '#282828',
      surface: '#32302f',
      'surface-alt': '#2d2b2a',
      fg: '#ebdbb2',
      'fg-muted': '#bdae93',
      border: '#3c3836',
      'border-strong': '#5a524c',
      accent: '#83a598',
      'accent-hover': '#a3c0b4',
      visited: '#d3869b',
      'on-accent': '#282828',
      selection: '#504945',
      scrollbar: '#5a524c',
      'mark-bg': '#5c4a12',
      'tk-keyword': '#fc6857',
      'tk-string': '#b8bb26',
      'tk-comment': '#a89984',
      'tk-number': '#d3869b',
      'tk-title': '#8ec07c',
      'tk-builtin': '#fabd2f',
      'tk-tag': '#83a598',
      'tk-meta': '#bdae93',
      'tk-punct': '#d5c4a1',
      'tk-addition': '#b8bb26',
      'tk-addition-bg': '#2f3320',
      'tk-deletion': '#fb5642',
      'tk-deletion-bg': '#3a2320',
    },
  },
  {
    id: 'high-contrast',
    label: 'High contrast',
    note: 'Every colour clears WCAG AAA (7:1). No decorative tints.',
    light: {
      bg: '#ffffff',
      surface: '#f2f2f2',
      'surface-alt': '#f8f8f8',
      fg: '#000000',
      'fg-muted': '#3a3a3a',
      border: '#767676',
      'border-strong': '#3a3a3a',
      accent: '#00459e',
      'accent-hover': '#002d6b',
      visited: '#6b1f8f',
      'on-accent': '#ffffff',
      selection: '#c7dcff',
      scrollbar: '#767676',
      'mark-bg': '#ffe97f',
      'tk-keyword': '#9a0000',
      'tk-string': '#00427a',
      'tk-comment': '#3a3a3a',
      'tk-number': '#00459e',
      'tk-title': '#5c1a8a',
      'tk-builtin': '#7a2a00',
      'tk-tag': '#00521f',
      'tk-meta': '#3a3a3a',
      'tk-punct': '#2b2b2b',
      'tk-addition': '#00521f',
      'tk-addition-bg': '#dcf5e2',
      'tk-deletion': '#8a0000',
      'tk-deletion-bg': '#fde2e0',
    },
    dark: {
      bg: '#000000',
      surface: '#141414',
      'surface-alt': '#0a0a0a',
      fg: '#ffffff',
      'fg-muted': '#cfcfcf',
      border: '#8a8a8a',
      'border-strong': '#cfcfcf',
      accent: '#8ec2ff',
      'accent-hover': '#b6d8ff',
      visited: '#dfa8ff',
      'on-accent': '#000000',
      selection: '#3a4a66',
      scrollbar: '#8a8a8a',
      'mark-bg': '#4f4200',
      'tk-keyword': '#ff9c93',
      'tk-string': '#8fd8ff',
      'tk-comment': '#c4c4c4',
      'tk-number': '#8ec2ff',
      'tk-title': '#e0aeff',
      'tk-builtin': '#ffbe7a',
      'tk-tag': '#7ee59a',
      'tk-meta': '#c4c4c4',
      'tk-punct': '#e0e0e0',
      'tk-addition': '#7ee59a',
      'tk-addition-bg': '#0d1f12',
      'tk-deletion': '#ff9c93',
      'tk-deletion-bg': '#24100f',
    },
  },
] as const satisfies ReadonlyArray<ThemePreset>;

export type ThemePresetId = (typeof THEME_PRESETS)[number]['id'];

/* -------------------------------------------------------------------------- */
/* Settings export/import                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Identifies a settings file as ours. Checked before anything else on import,
 * so pointing the picker at an unrelated .json produces "that isn't a settings
 * file" rather than a list of complaints about missing fields.
 */
export const SETTINGS_FILE_FORMAT = 'markdown-viewer-settings';

/**
 * Bumped only when an old file can no longer be read as-is. Import accepts any
 * version at or below this, and accepts higher ones too — see `settings-io.ts`,
 * which reads what it recognises and reports the rest rather than refusing a
 * file written by a build the user upgraded from.
 */
export const SETTINGS_FILE_VERSION = 1;

/** Suggested name for the downloaded file, before the date is appended. */
export const SETTINGS_FILE_BASENAME = 'markdown-viewer-settings';

/* -------------------------------------------------------------------------- */
/* Markdown pipeline                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `html: true` is not a relaxation, it is a statement about where safety comes
 * from. A README that wraps a section in `<details>` is ordinary, and escaping
 * it would render the tags as text; what makes the output safe is PURIFY_CONFIG
 * below, applied to everything, rather than the parser refusing one input shape.
 *
 * `linkify` is off because turning every bare URL into a link invents links the
 * author did not write — and `lib/links.ts` then decorates them as external.
 * `typographer` is off because it rewrites quotes and dashes inside prose that
 * is often quoting an exact string.
 */
export const MARKDOWN_IT_OPTIONS: MarkdownItOptions = {
  html: true,
  xhtmlOut: false,
  breaks: false,
  linkify: false,
  typographer: false,
};

/**
 * The language tag is appended to this, so the emitted class is
 * `hljs language-ts` — the stylesheet keys off the `hljs` class and the token
 * spans, `lib/export.ts` carries the same rules, and the mermaid add-on finds
 * its blocks by `language-mermaid`. All three parts have to be there.
 *
 * markdown-it's own `langPrefix` is deliberately not used: it emits no class at
 * all for a fence with no language, which would drop the `hljs` class that
 * unlabelled blocks have always carried. `lib/markdown.ts` builds the whole
 * `<pre>` instead.
 */
export const HIGHLIGHT_LANG_PREFIX = 'hljs language-';
export const HIGHLIGHT_EMPTY_LANG_CLASS = 'hljs';

/**
 * Class prefix shared by GitHub alerts (`> [!NOTE]`) and `:::` containers.
 *
 * One prefix for both on purpose: they are the same thing written twice by two
 * ecosystems, and giving them one shape means one block of CSS, one set of
 * icons, and no chance of the two drifting apart visually.
 */
export const ALERT_CLASS_PREFIX = 'mdv-alert';

/**
 * The five GitHub alert markers, and the only names an icon exists for.
 * Uppercase because that is how they are written; matching is case-insensitive.
 */
export const ALERT_MARKERS = [
  'NOTE',
  'TIP',
  'IMPORTANT',
  'WARNING',
  'CAUTION',
] as const;

export type AlertKind = Lowercase<(typeof ALERT_MARKERS)[number]>;

/**
 * `:::name` containers, as MkDocs, Docusaurus and VitePress spell them.
 *
 * Each maps onto one of the five alert kinds rather than introducing a palette
 * of its own: `:::danger` and `> [!CAUTION]` mean the same thing to a reader,
 * and a document that uses both should not look like it uses two systems. The
 * title is what appears when the author writes no title of their own.
 */
export const CONTAINER_TYPES: ReadonlyArray<{
  name: string;
  title: string;
  kind: AlertKind;
}> = [
  { name: 'note', title: 'Note', kind: 'note' },
  { name: 'info', title: 'Info', kind: 'note' },
  { name: 'tip', title: 'Tip', kind: 'tip' },
  { name: 'important', title: 'Important', kind: 'important' },
  { name: 'warning', title: 'Warning', kind: 'warning' },
  { name: 'caution', title: 'Caution', kind: 'caution' },
  { name: 'danger', title: 'Danger', kind: 'caution' },
];

/**
 * MultiMarkdown table extensions. Only the ones that are strict supersets of
 * GFM are on, so a table that parsed before parses identically now.
 *
 * `multibody` is off because it is not a superset, and the way it fails is
 * silent: it treats a blank line inside a table as a `<tbody>` break, which
 * means two ordinary GFM tables written back to back become one table whose
 * second header row renders as a row of literal `---` cells. Two tables in a
 * row is far commoner in a README than multiple row groups in one.
 *
 * `autolabel` is off for a duller reason: it mints an `id` on every captioned
 * table out of the caption text, in the same namespace as the heading slugs,
 * and nothing in the viewer links to a table.
 */
export const MULTIMD_TABLE_OPTIONS = {
  multiline: true,
  rowspan: true,
  headerless: true,
  multibody: false,
  autolabel: false,
};

/**
 * What `[[Page Name]]` resolves to.
 *
 * A relative `.md` sibling, because that is what the link means in every folder
 * of notes that uses the syntax — and because a relative href is the one form the
 * browser resolves correctly for a `file://` note and a served one alike.
 * Spaces are kept rather than turned into underscores: the target is a real file
 * whose name is what the author typed. `lib/markdown.ts` describes what is left
 * unresolved for documents opened through a directory handle.
 */
export const WIKILINK_SUFFIX = '.md';
export const WIKILINK_CLASS = 'mdv-wikilink';

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
  // `mathMl` and `svg` are both here for KaTeX, which needs both halves of its
  // output: the <math> tree screen readers actually read, and the inline <svg>
  // that draws radicals and stretchy arrows — `\sqrt{x}` loses its surd
  // entirely without it. Neither profile admits script, event handlers,
  // <foreignObject> or <use>; they widen what may *appear*, not what may run.
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  // The one deliberate hole in the MathML profile, reopened by hand. DOMPurify
  // disallows this family because `<annotation-xml>` is an mXSS vector — it can
  // carry HTML into the MathML namespace. Its two plain siblings cannot, and
  // dropping them is not free: `KEEP_CONTENT` then hoists the raw TeX out of
  // the discarded `<annotation>` and into `<math>` as loose text, which every
  // screen reader reads aloud. `annotation-xml` stays disallowed.
  ADD_TAGS: ['semantics', 'annotation'],
  // `colspan`/`rowspan` arrive with MultiMarkdown tables. Both are in
  // DOMPurify's defaults; pinning them here is the same insurance as `align`.
  ADD_ATTR: ['align', 'type', 'checked', 'disabled', 'colspan', 'rowspan'],
  // Nothing in markdown output needs data-*; dropping them shrinks the surface
  // for attribute-based gadgets in whatever consumes the DOM later.
  ALLOW_DATA_ATTR: false,
  // A stylesheet from an untrusted .md could reposition or hide our own UI.
  // Now that the SVG profile is on this also covers SVG's own `<style>`, which
  // is the same hazard wearing a different namespace.
  FORBID_TAGS: ['style'],
};

/**
 * KaTeX is handed TeX out of an untrusted .md, so every option here is a limit
 * rather than a preference.
 *
 * `trust` is the load-bearing one and the reason it is pinned rather than left
 * to its (identical) default: it is what keeps `\includegraphics` and `\href`
 * disabled, and `\includegraphics` is a network request in TeX's clothing.
 */
export const KATEX_OPTIONS: MarkdownKatexOptions & KatexOptions = {
  // Off, all four of them. `\begin{…}` without `$$`, `$$` inside raw HTML
  // blocks, and ```math fences each hand a second syntax the power to become
  // math — and the last one would take a fenced block away from the code path
  // that the copy button, the highlighter and the mermaid add-on all rely on.
  enableBareBlocks: false,
  enableMathBlockInHtml: false,
  enableMathInlineInHtml: false,
  enableFencedBlocks: false,
  // A malformed formula must render as a legible error in place, not abort the
  // parse and cost the reader the whole document.
  throwOnError: false,
  // The default, 'warn', puts a console line on screen for every questionable
  // construct — that is feedback for an author, and we are not the author.
  strict: 'ignore',
  trust: false,
  // Unbounded by default: `\rule{500em}{500em}` is a one-line layout bomb.
  maxSize: 25,
};
