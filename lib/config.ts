/**
 * The values that cross contexts: activation rules, the DOM contract, build
 * output paths, the add-on table, permissions, the global settings, and the
 * markdown and sanitizer configuration `lib/markdown.ts` is built from.
 *
 * Nothing here imports from the rest of the codebase, so it can be pulled into
 * any context (service worker, content script, extension page, node test) with
 * no risk of a cycle. That is the whole reason the file exists, and it is also
 * the test for what belongs in it.
 *
 * The rule, which this file did not used to keep: **a constant lives with the
 * code that reads it.** A value read by one plugin is that plugin's; one read by
 * one module is that module's. What is left here is what two contexts have to
 * agree on and neither can own — a filename the service worker injects and the
 * build check asserts, a class the parser writes and an add-on finds, a scheme
 * three unrelated modules must recognise. Adding something here means answering
 * why the module that reads it cannot hold it instead.
 *
 * `scripts/check-build.mjs` parses `RENDERER_JS`, `RENDERER_CSS_FILES`,
 * `REQUIRED_PERMISSIONS` and `ADDONS` out of this file by regex, and
 * `scripts/audit-network.mjs` does the same to `FETCH_ALLOWLIST`. Reformatting
 * any of the five breaks a build check silently; run both after touching them.
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

/* -------------------------------------------------------------------------- */
/* Folder browser                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Identity scheme for a document read through a directory handle rather than
 * fetched from an address.
 *
 * Here rather than with the rest of the folder constants — which moved to
 * `lib/folder.ts`, the only module that reads them — because this one is an
 * activation rule wearing a folder's clothes: `lib/live-reload.ts`, the wikilink
 * plugin and `documentKey()` all have to recognise it, and none of them opens a
 * directory.
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
  // Export is here for the same reason mermaid is, only the trigger differs: a
  // document cannot be inspected for "will be exported", so the menu asks for
  // this the first time a format is picked rather than at render time.
  export: { js: 'export-addon.js', css: [] as string[] },
  // jsdiff, and nothing else. No stylesheet: unlike mermaid and katex, the
  // comparison's UI is a React component in the renderer bundle, so its CSS is
  // already inside `assets/renderer.css`. Only the engine is deferred.
  diff: { js: 'diff-addon.js', css: [] as string[] },
} as const;

export type AddonName = keyof typeof ADDONS;

/**
 * How long to wait for an add-on's bridge to appear after the service worker
 * has reported the injection succeeded.
 *
 * `executeScript` resolves once the file has finished evaluating, so in practice
 * the bridge is already there when the promise settles and this never elapses.
 * It exists for the one case where it isn't — a bundle that threw on its way up
 * — so that ends in a message the reader can act on rather than a spinner that
 * never stops.
 */
export const ADDON_READY_TIMEOUT_MS = 8_000;

/** Marks a code block the mermaid add-on should replace with a diagram. */
export const MERMAID_LANGUAGE = 'mermaid';

/** Class KaTeX puts on math it has rendered. */
export const MATH_CLASS = 'katex';

/**
 * What the pipeline emits in place of a formula, for the KaTeX add-on to render.
 *
 * The TeX travels as the element's *text*, not in a `data-` attribute:
 * PURIFY_CONFIG sets `ALLOW_DATA_ATTR: false`, so an attribute would be stripped
 * on the way out of the parser. Text content survives sanitization, is escaped
 * by construction, and is the reason a reader whose add-on never arrives still
 * sees `x^2` rather than a blank space.
 */
export const MATH_PLACEHOLDER_CLASS = 'mdv-math';
export const MATH_INLINE_CLASS = 'mdv-math-inline';
export const MATH_DISPLAY_CLASS = 'mdv-math-display';

/**
 * Where the export add-on publishes its entry point.
 *
 * A property on the isolated world's `window`, which is shared by every content
 * script this extension puts in the frame and invisible to the page itself. The
 * add-on and `components/ExportMenu.tsx` are two scripts in one realm rather
 * than two realms, so the menu can hand over a live `Element` and a progress
 * callback and take back a promise — no serialization, no id bookkeeping, and
 * no request that can be left waiting for a reply that never comes.
 */
export const EXPORT_BRIDGE_KEY = '__mdvExport';

/* -------------------------------------------------------------------------- */
/* Document comparison                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where the diff add-on publishes jsdiff, on the same isolated-world `window`
 * that `EXPORT_BRIDGE_KEY` above uses and for the same reasons — one realm
 * shared by every script this extension injects into the frame, invisible to
 * the document, so a live function can simply be handed over.
 *
 * A property rather than a module binding because each injection re-evaluates
 * the add-on with a fresh module scope; see the header of
 * `entrypoints/mermaid-addon.ts` for the same constraint solved the other way.
 */
export const DIFF_BRIDGE_KEY = '__mdvDiff';

/** Fired on `window` once the key above is set, so a waiter need not poll. */
export const DIFF_READY_EVENT = 'mdv-diff-ready';

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
 * The *global* settings, and only those: the ones that describe the document
 * itself rather than any one feature, so that several plugins read them and the
 * options page writes them through one bag.
 *
 * Everything else that used to live here is a plugin now. "Is there a sidebar",
 * "does math render", "are slides offered" are each one concept — a plugin's
 * enabled state — rather than a setting and a plugin that could disagree, and a
 * feature's own knobs live in its `settings` schema under its own id. A field
 * added here has to answer why every plugin should be able to see it.
 */
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  themePreset: 'default',
  customCss: '',
  fontFamily: 'system',
  fontSize: 16,
  lineHeight: 1.65,
  contentWidth: 'normal',
};

/**
 * The global settings, as a list, so code that has to enumerate them does not
 * restate the interface. `test/settings-io.test.ts` asserts it matches
 * `DEFAULT_SETTINGS` exactly, which is what keeps a field added above from
 * being silently unexportable.
 */
export const GLOBAL_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/**
 * Modules permitted to call `fetch`. Enforced against the source tree by
 * `scripts/audit-network.mjs`, so a request appearing anywhere else fails the
 * build rather than being noticed in review.
 */
export const FETCH_ALLOWLIST = ['lib/live-reload.ts'];

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
 * Every preset id, in the order they are offered.
 *
 * The ids live here and the palettes live in `lib/theme-presets.ts`. The split
 * is not arbitrary: `themePreset` is a *setting*, so its type has to be
 * available wherever `Settings` is, and this module imports nothing. Three
 * hundred lines of colour belong with the code that resolves and applies them,
 * where the contrast test already is — `THEME_PRESETS` is declared against this
 * list, so a palette cannot be added there without an id here, or removed while
 * an id still names it.
 */
export const THEME_PRESET_IDS = [
  'default',
  'solarized',
  'nord',
  'gruvbox',
  'high-contrast',
] as const;

export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

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
  // `svg` is here for the alert and container icons, which `lib/markdown.ts`
  // writes as inline SVG and this pass would otherwise delete — every `> [!NOTE]`
  // would lose its mark. The profile admits no script, no event handlers, no
  // <foreignObject> and no <use>; it widens what may *appear*, not what may run.
  //
  // `mathMl` used to be here too, for the KaTeX output the parser emitted, along
  // with a hand-reopened `ADD_TAGS: ['semantics', 'annotation']` — DOMPurify
  // disallows that family because `<annotation-xml>` can carry HTML into the
  // MathML namespace. Nothing in the pipeline produces MathML any more: math
  // leaves here as a placeholder and is rendered by `entrypoints/katex-addon.ts`,
  // which sanitizes its own output with those two widenings applied to KaTeX
  // markup alone. Keeping them here would mean every .md file on the web could
  // hand us MathML in raw HTML for no remaining benefit, so they are gone. The
  // cost, stated plainly: a document that hand-writes `<math>` now reads as its
  // own text rather than as a formula.
  USE_PROFILES: { html: true, svg: true },
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
