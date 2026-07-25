/**
 * Export the rendered document to a standalone HTML file or a Word document.
 *
 * Both are produced entirely in the page. Nothing is uploaded and nothing is
 * requested: the document is already in the DOM, its images are already decoded
 * in the page, and the stylesheet is a constant in this file. That constraint is
 * what shapes almost every decision below — most obviously the canvas dance in
 * `snapshotImage`, which exists because re-fetching an `<img>` by its URL would
 * be a network call the extension does not make.
 *
 * This is the library, not the entry point. Filename derivation, document
 * cleaning, HTML assembly, the DOM → Word mapping and the image snapshots are
 * all here; `exportDocument`, which strings them together and hands the result
 * to the browser, lives in `entrypoints/export-addon.ts`. The split is what
 * keeps ~400 kB of `docx` out of the renderer: nothing in the React tree
 * imports this module, so nothing but the add-on pulls in what it imports.
 * `test/export.test.ts` covers the whole of it under jsdom.
 */

import {
  AlignmentType,
  BorderStyle,
  Document as WordDocument,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx';

import {
  CONTENT_WIDTH_CH,
  EXPORT_FORMATS,
  FONT_STACKS,
  MARKDOWN_EXTENSIONS,
  MATH_CLASS,
  type ContentWidth,
  type ExportFormat,
  type FontFamily,
} from './config.ts';
import { escapeHtml } from './markdown.ts';

/* -------------------------------------------------------------------------- */
/* Public shape                                                                */
/* -------------------------------------------------------------------------- */

export type ExportTheme = 'light' | 'dark';

/** The reader's typography, carried into the export so it matches the screen. */
export interface ExportTypography {
  fontFamily?: FontFamily;
  fontSize?: number;
  lineHeight?: number;
  contentWidth?: ContentWidth;
}

export interface ExportProgress {
  stage: 'images' | 'building' | 'saving';
  done: number;
  total: number;
}

export interface ExportOptions {
  format: ExportFormat;
  /** The live rendered document — the `.mdv-body` element. */
  body: Element;
  theme?: string;
  typography?: ExportTypography;
  /** The document's own address, used to resolve relative links and to name the file. */
  url?: string;
  /** Overrides the title derived from the first heading. */
  title?: string;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportResult {
  format: ExportFormat;
  filename: string;
  totalImages: number;
  /**
   * Images left as an external reference (HTML) or as alt text (DOCX). Always
   * surfaced: a silently broken file is worse than a reported partial one.
   */
  skippedImages: number;
}

/** Used whenever the document offers nothing to name the file after. */
const FALLBACK_FILENAME = 'document';

/* -------------------------------------------------------------------------- */
/* Filenames                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A document is untrusted input, and its first heading is what names the file.
 * `# ../../etc/passwd` must not come back out as a path, a hidden dotfile, or a
 * Windows device — so the rules below are subtractive only, and the result is a
 * single path segment or nothing.
 */
const FILENAME_MAX = 100;

/** Still a device on Windows whatever extension is appended to it. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(raw: string): string {
  let name = raw
    .normalize('NFC')
    // Control characters first: a NUL truncates the name in some APIs, and a
    // newline hides everything after it in the download shelf.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Path separators, so nothing that survives can be read as a directory.
    .replace(/[\\/]+/g, '')
    // Reserved on Windows; `:` additionally opens an alternate data stream.
    .replace(/[<>:"|?*]/g, '')
    .replace(/\s+/g, '-')
    // What `..` degenerates to once the separators are gone. Collapsing runs of
    // dots also stops a leading `.` from making the export a hidden file.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-\s]+$/, '');

  if (name.length > FILENAME_MAX) {
    name = name.slice(0, FILENAME_MAX).replace(/[.\-\s]+$/, '');
  }

  if (!name) return FALLBACK_FILENAME;
  return WINDOWS_RESERVED.test(name) ? `${name}-file` : name;
}

const MARKDOWN_EXTENSION_RE = new RegExp(
  `(?:${MARKDOWN_EXTENSIONS.map((ext) => ext.replace('.', '\\.')).join('|')})$`,
  'i',
);

/** The first heading, or failing that the file's own name. */
export function documentTitle(root: Element | null, url = ''): string {
  const heading = root?.querySelector('h1, h2, h3, h4');
  const text = heading?.textContent?.trim();
  if (text) return text;

  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = decodeURIComponent(segments[segments.length - 1] ?? '');
    if (last) return last.replace(MARKDOWN_EXTENSION_RE, '');
  } catch {
    // Not something `URL` can parse; the fallback below is the answer.
  }

  return FALLBACK_FILENAME;
}

export function exportFilename(title: string, format: ExportFormat): string {
  const spec = EXPORT_FORMATS.find((entry) => entry.value === format);
  return sanitizeFilename(title) + (spec?.extension ?? '');
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImageSnapshot {
  /** Always a `data:` URL, so the exported file references nothing. */
  dataUrl: string;
  mime: string;
  width: number;
  height: number;
}

/** How many images to serialize before yielding, so a big export still paints. */
const IMAGE_YIELD_INTERVAL = 8;

function dataUrlMime(url: string): string {
  return /^data:([^;,]+)/.exec(url)?.[1]?.toLowerCase() ?? '';
}

/**
 * Serializes an image that is already decoded in the page.
 *
 * A cross-origin image taints the canvas it is drawn into, and `toDataURL` then
 * throws `SecurityError`. That is not recoverable without re-requesting the
 * image, which is precisely what this extension will not do — so the caller
 * gets `null` and reports the image as un-embedded rather than failing the
 * whole export or writing a file with a hole in it.
 */
function snapshotImage(image: Element): ImageSnapshot | null {
  const element = image as HTMLImageElement;
  const width = element.naturalWidth;
  const height = element.naturalHeight;
  // Never decoded — an image that failed to load, or one this document has not
  // scrolled to. There is nothing in memory to serialize.
  if (!width || !height) return null;

  const source = element.currentSrc || element.src || '';
  // Already inline. Re-encoding would only cost size, and for a format the
  // canvas cannot round-trip (an animated GIF, an SVG) it would cost fidelity.
  if (source.startsWith('data:')) {
    return { dataUrl: source, mime: dataUrlMime(source), width, height };
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(element, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), mime: 'image/png', width, height };
  } catch {
    return null;
  }
}

export async function snapshotImages(
  images: readonly Element[],
  onProgress?: (progress: ExportProgress) => void,
): Promise<(ImageSnapshot | null)[]> {
  const out: (ImageSnapshot | null)[] = [];

  for (const [index, image] of images.entries()) {
    out.push(snapshotImage(image));

    if (index % IMAGE_YIELD_INTERVAL === IMAGE_YIELD_INTERVAL - 1) {
      onProgress?.({ stage: 'images', done: index + 1, total: images.length });
      // Encoding a hundred screenshots is enough work to freeze the tab, and
      // the progress report above is worthless if nothing can repaint.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  onProgress?.({ stage: 'images', done: images.length, total: images.length });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Cleaning the document for export                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything that exists only for the on-screen viewer. `data-mdv-chrome` is the
 * shared convention; the rest are the affordances `Document.tsx` grafts on,
 * named explicitly because they predate the attribute.
 */
const CHROME_SELECTOR = '[data-mdv-chrome], .mdv-toolbar, .mdv-copy, .mdv-anchor, button, nav';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function tagOf(element: Element): string {
  return element.tagName.toLowerCase();
}

function absolute(url: string, base: string): string {
  try {
    return new URL(url, base || undefined).href;
  } catch {
    return url;
  }
}

/**
 * A copy of the rendered document with the viewer stripped out of it.
 *
 * The export is the document, not the reader's window on it: no toolbars, no
 * copy buttons, no heading anchors. Links and image sources are resolved
 * against the document's own address, because the file is about to be opened
 * from somewhere else entirely — but in-page anchors stay relative, or every
 * table-of-contents link in the export would navigate back to the original.
 *
 * `images` is indexed in document order, which is the order `querySelectorAll`
 * returns and therefore the same order in the clone.
 */
export function cleanForExport(
  root: Element,
  options: {
    baseUrl?: string;
    images?: readonly (ImageSnapshot | null)[];
  } = {},
): Element {
  const { baseUrl = '', images = [] } = options;
  const clone = root.cloneNode(true) as Element;

  clone.querySelectorAll(CHROME_SELECTOR).forEach((node) => node.remove());

  // The copy button lived in a wrapper around each code block. With the button
  // gone the wrapper is a bare div the export stylesheet knows nothing about.
  clone.querySelectorAll('.mdv-code').forEach((wrapper) => {
    const pre = wrapper.querySelector('pre');
    if (pre) wrapper.replaceWith(pre);
  });

  // KaTeX renders each formula twice: hidden MathML for assistive technology and
  // a stack of absolutely positioned spans for sighted readers. Only the second
  // needs katex.css, which the export does not carry — so keep the MathML, which
  // every current browser renders natively, and drop the rest.
  clone.querySelectorAll(`.${MATH_CLASS}`).forEach((formula) => {
    const math = formula.querySelector('math');
    if (math) formula.replaceWith(math);
  });

  clone.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href') ?? '';
    if (!href.startsWith('#')) link.setAttribute('href', absolute(href, baseUrl));
  });

  clone.querySelectorAll('img').forEach((image, index) => {
    const snapshot = images[index];
    if (!snapshot) {
      // Could not be embedded. Absolutizing at least leaves a link that resolves
      // from wherever the file ends up, rather than a dead relative path.
      const src = image.getAttribute('src');
      if (src) image.setAttribute('src', absolute(src, baseUrl));
      return;
    }

    image.setAttribute('src', snapshot.dataUrl);
    // Intrinsic size on the element, so the exported page reserves the right box
    // before decoding and the DOCX planner has dimensions to scale from.
    image.setAttribute('width', String(snapshot.width));
    image.setAttribute('height', String(snapshot.height));
    image.removeAttribute('loading');
    image.removeAttribute('srcset');
  });

  // The viewer's own bookkeeping. Harmless, but it is not part of the document.
  clone.querySelectorAll('[data-mdv-copied]').forEach((node) => {
    node.removeAttribute('data-mdv-copied');
  });

  return clone;
}

/* -------------------------------------------------------------------------- */
/* HTML export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The document half of `entrypoints/viewer.css`, reconstructed rather than
 * imported.
 *
 * `?raw` was the other option and was rejected twice over. The smaller reason is
 * that the test runner is plain node with `--experimental-strip-types`, which
 * cannot resolve a Vite query suffix, so importing the sheet would make every
 * assertion about the exported HTML untestable. The larger one is that viewer.css
 * is not the right stylesheet for a file: roughly a third of it is host-page
 * reset, flex shell, sidebar track and `#mdv-root button` print rules — all of
 * it describing chrome the export deliberately does not contain.
 *
 * What is kept is faithful to viewer.css and in the same order (theme tokens,
 * document column, headings, inline text, links, lists, media, code, the
 * highlight.js token theme, tables, print). Keeping the class names identical is
 * what makes the two comparable at a glance when one of them changes.
 */
export const EXPORT_CSS = `
:root[data-mdv-theme='light'] {
  color-scheme: light;
  --mdv-bg: #ffffff;
  --mdv-surface: #f6f8fa;
  --mdv-surface-alt: #fafbfc;
  --mdv-fg: #1f2328;
  --mdv-fg-muted: #5a636d;
  --mdv-border: #d5dbe1;
  --mdv-border-strong: #b6bfc9;
  --mdv-accent: #0a53be;
  --mdv-accent-hover: #08409a;
  --mdv-visited: #6639ba;
  --mdv-on-accent: #ffffff;
  --mdv-selection: #cfe3ff;
  --mdv-mark-bg: #fff3c4;
  --mdv-tk-keyword: #b3202c;
  --mdv-tk-string: #0a3069;
  --mdv-tk-comment: #5f6874;
  --mdv-tk-number: #0550ae;
  --mdv-tk-title: #7a3fd0;
  --mdv-tk-builtin: #8a3400;
  --mdv-tk-tag: #0f5c28;
  --mdv-tk-meta: #57606a;
  --mdv-tk-punct: #4a545e;
  --mdv-tk-addition: #0f5c28;
  --mdv-tk-addition-bg: #e6ffec;
  --mdv-tk-deletion: #8a1420;
  --mdv-tk-deletion-bg: #ffebe9;
}

:root[data-mdv-theme='dark'] {
  color-scheme: dark;
  --mdv-bg: #0d1117;
  --mdv-surface: #161b22;
  --mdv-surface-alt: #12171f;
  --mdv-fg: #e6edf3;
  --mdv-fg-muted: #9aa4af;
  --mdv-border: #30363d;
  --mdv-border-strong: #4a525c;
  --mdv-accent: #6cb1ff;
  --mdv-accent-hover: #8cc4ff;
  --mdv-visited: #c4a0ff;
  --mdv-on-accent: #0d1117;
  --mdv-selection: #2d4f7c;
  --mdv-mark-bg: #4a3a12;
  --mdv-tk-keyword: #ff8a80;
  --mdv-tk-string: #a8d5ff;
  --mdv-tk-comment: #9aa4af;
  --mdv-tk-number: #84c5ff;
  --mdv-tk-title: #d7b3ff;
  --mdv-tk-builtin: #ffb070;
  --mdv-tk-tag: #8ceb96;
  --mdv-tk-meta: #a5b1bd;
  --mdv-tk-punct: #c2cbd4;
  --mdv-tk-addition: #8ceb96;
  --mdv-tk-addition-bg: #10251a;
  --mdv-tk-deletion: #ffaba4;
  --mdv-tk-deletion-bg: #2b1416;
}

:root {
  /* System stacks only — a webfont URL would be a network request. */
  --mdv-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text',
    'Segoe UI', ui-sans-serif, system-ui, Roboto, 'Helvetica Neue', Arial,
    'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;
  --mdv-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
    'Liberation Mono', 'Roboto Mono', 'Courier New', monospace;
  --mdv-scale-1: 1.2em;
  --mdv-scale-2: 1.44em;
  --mdv-scale-3: 1.728em;
  --mdv-scale-4: 2.074em;
  --mdv-leading: 1.65;
  --mdv-block-gap: 1.15em;
  --mdv-radius: 8px;
  --mdv-radius-sm: 4px;
}

html, body {
  margin: 0;
  padding: 0;
  min-height: 100%;
  background-color: var(--mdv-bg);
  color: var(--mdv-fg);
  tab-size: 4;
}

body, body * { box-sizing: border-box; }

.mdv-body {
  max-width: var(--mdv-measure, 72ch);
  margin-inline: auto;
  padding-inline: clamp(1.15rem, 5vw, 2rem);
  padding-block: clamp(2rem, 6vw, 3.75rem) 6rem;
  font-family: var(--mdv-font-body, var(--mdv-font-sans));
  font-size: var(--mdv-font-size, clamp(1rem, 0.955rem + 0.22vw, 1.09rem));
  line-height: var(--mdv-line-height, var(--mdv-leading));
  overflow-wrap: break-word;
  font-synthesis-weight: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

.mdv-body > :first-child { margin-top: 0; }
.mdv-body > :last-child { margin-bottom: 0; }

.mdv-body p, .mdv-body ul, .mdv-body ol, .mdv-body dl, .mdv-body pre,
.mdv-body blockquote, .mdv-body table, .mdv-body figure, .mdv-body details {
  margin: 0 0 var(--mdv-block-gap);
}

.mdv-body p { text-wrap: pretty; }

.mdv-body h1, .mdv-body h2, .mdv-body h3,
.mdv-body h4, .mdv-body h5, .mdv-body h6 {
  font-family: inherit;
  font-weight: 650;
  color: var(--mdv-fg);
  text-wrap: balance;
}

.mdv-body h1 {
  font-size: var(--mdv-scale-4);
  line-height: 1.18;
  letter-spacing: -0.021em;
  margin: 1.35em 0 0.55em;
  padding-bottom: 0.28em;
  border-bottom: 1px solid var(--mdv-border);
}

.mdv-body h2 {
  font-size: var(--mdv-scale-3);
  line-height: 1.24;
  letter-spacing: -0.017em;
  margin: 1.7em 0 0.6em;
  padding-bottom: 0.28em;
  border-bottom: 1px solid var(--mdv-border);
}

.mdv-body h3 { font-size: var(--mdv-scale-2); line-height: 1.32; letter-spacing: -0.011em; margin: 1.8em 0 0.6em; }
.mdv-body h4 { font-size: var(--mdv-scale-1); line-height: 1.4; letter-spacing: -0.006em; margin: 1.9em 0 0.65em; }
.mdv-body h5 { font-size: 1em; line-height: 1.5; margin: 2em 0 0.7em; }
.mdv-body h6 {
  font-size: 0.85em;
  line-height: 1.5;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--mdv-fg-muted);
  margin: 2.3em 0 0.8em;
}

.mdv-body strong, .mdv-body b { font-weight: 650; color: var(--mdv-fg); }
.mdv-body em, .mdv-body i { font-style: italic; }
.mdv-body del, .mdv-body s { color: var(--mdv-fg-muted); text-decoration: line-through; }
.mdv-body ins { text-decoration: underline; text-underline-offset: 0.15em; }
.mdv-body mark {
  background-color: var(--mdv-mark-bg);
  color: var(--mdv-fg);
  padding: 0.1em 0.2em;
  border-radius: var(--mdv-radius-sm);
}
.mdv-body small { font-size: 0.875em; color: var(--mdv-fg-muted); }
.mdv-body sub, .mdv-body sup { font-size: 0.75em; line-height: 0; position: relative; vertical-align: baseline; }
.mdv-body sup { top: -0.5em; }
.mdv-body sub { bottom: -0.25em; }
.mdv-body abbr[title] { text-decoration: underline dotted; text-underline-offset: 0.2em; }
.mdv-body kbd {
  font-family: var(--mdv-font-mono);
  font-size: 0.8em;
  line-height: 1;
  padding: 0.25em 0.45em;
  border: 1px solid var(--mdv-border-strong);
  border-bottom-width: 2px;
  border-radius: var(--mdv-radius-sm);
  background-color: var(--mdv-surface);
  white-space: nowrap;
}

.mdv-body a { color: var(--mdv-accent); text-decoration: none; text-underline-offset: 0.16em; }
.mdv-body a:visited { color: var(--mdv-visited); }
.mdv-body a:hover, .mdv-body a:active { color: var(--mdv-accent-hover); text-decoration: underline; }
.mdv-body a code { color: inherit; }
.mdv-body :focus-visible { outline: 2px solid var(--mdv-accent); outline-offset: 2px; }

.mdv-body ul, .mdv-body ol { padding-left: 1.6em; }
.mdv-body ul { list-style-type: disc; }
.mdv-body ul ul { list-style-type: circle; }
.mdv-body ul ul ul { list-style-type: square; }
.mdv-body ol ol { list-style-type: lower-alpha; }
.mdv-body ol ol ol { list-style-type: lower-roman; }
.mdv-body li { margin: 0.3em 0; }
.mdv-body li::marker { color: var(--mdv-fg-muted); }
.mdv-body li > ul, .mdv-body li > ol { margin: 0.3em 0 0.4em; }
.mdv-body li > p { margin-bottom: 0.5em; }
.mdv-body li > :last-child { margin-bottom: 0; }
.mdv-body dt { font-weight: 650; margin-top: 0.9em; }
.mdv-body dd { margin: 0.3em 0 0 1.6em; color: var(--mdv-fg-muted); }

.mdv-body li:has(> input[type='checkbox']:first-child) {
  list-style: none;
  margin-left: -1.6em;
  padding-left: 0;
}

.mdv-body input[type='checkbox'] {
  appearance: none;
  display: inline-block;
  position: relative;
  width: 1.05em;
  height: 1.05em;
  margin: 0 0.5em 0 0;
  vertical-align: -0.16em;
  border: 1px solid var(--mdv-border-strong);
  border-radius: 0.28em;
  background-color: var(--mdv-surface);
}

.mdv-body input[type='checkbox']:checked {
  background-color: var(--mdv-accent);
  border-color: var(--mdv-accent);
}

.mdv-body input[type='checkbox']:checked::after {
  content: '';
  position: absolute;
  left: 33%;
  top: 12%;
  width: 0.26em;
  height: 0.52em;
  border: solid var(--mdv-on-accent);
  border-width: 0 0.13em 0.13em 0;
  transform: rotate(42deg);
}

.mdv-body input[type='checkbox']:disabled { opacity: 1; }

.mdv-body blockquote {
  padding: 0.1em 0 0.1em 1.1em;
  border-left: 3px solid var(--mdv-border-strong);
  color: var(--mdv-fg-muted);
}
.mdv-body blockquote > :first-child { margin-top: 0; }
.mdv-body blockquote > :last-child { margin-bottom: 0; }

.mdv-body hr {
  height: 1px;
  border: 0;
  margin: 2.6em 0;
  background-image: linear-gradient(90deg, transparent, var(--mdv-border-strong) 18%, var(--mdv-border-strong) 82%, transparent);
}

.mdv-body img, .mdv-body svg, .mdv-body video { max-width: 100%; height: auto; vertical-align: middle; }
.mdv-body p > img:only-child { display: block; margin-inline: auto; border-radius: var(--mdv-radius); }
.mdv-body figcaption { font-size: 0.875em; color: var(--mdv-fg-muted); text-align: center; margin-top: 0.6em; }

.mdv-body details {
  border: 1px solid var(--mdv-border);
  border-radius: var(--mdv-radius);
  padding: 0.75em 1em;
  background-color: var(--mdv-surface-alt);
}
.mdv-body summary { font-weight: 650; cursor: pointer; margin: -0.75em -1em; padding: 0.75em 1em; }
.mdv-body details[open] > summary { margin-bottom: 0.4em; border-bottom: 1px solid var(--mdv-border); }

.mdv-body code, .mdv-body pre, .mdv-body samp, .mdv-body tt {
  font-family: var(--mdv-font-mono);
  font-variant-ligatures: none;
}

.mdv-body code {
  font-size: 0.86em;
  padding: 0.18em 0.4em;
  border-radius: var(--mdv-radius-sm);
  background-color: var(--mdv-surface);
  border: 1px solid var(--mdv-border);
  white-space: break-spaces;
}

.mdv-body pre {
  font-size: 0.86em;
  line-height: 1.55;
  padding: 1em 1.15em;
  border: 1px solid var(--mdv-border);
  border-radius: var(--mdv-radius);
  background-color: var(--mdv-surface);
  color: var(--mdv-fg);
  overflow-x: auto;
  white-space: pre;
  tab-size: 2;
}

.mdv-body pre code {
  display: block;
  font-size: inherit;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  white-space: inherit;
  color: inherit;
}

.mdv-body blockquote pre, .mdv-body li pre { background-color: var(--mdv-bg); }

.mdv-body .hljs { display: block; color: var(--mdv-fg); background: none; }
.mdv-body .hljs-comment, .mdv-body .hljs-quote { color: var(--mdv-tk-comment); font-style: italic; }
.mdv-body .hljs-doctag { color: var(--mdv-tk-comment); font-weight: 650; }
.mdv-body .hljs-keyword, .mdv-body .hljs-selector-tag, .mdv-body .hljs-operator { color: var(--mdv-tk-keyword); }
.mdv-body .hljs-string, .mdv-body .hljs-regexp, .mdv-body .hljs-char.escape_, .mdv-body .hljs-subst { color: var(--mdv-tk-string); }
.mdv-body .hljs-number, .mdv-body .hljs-literal, .mdv-body .hljs-variable, .mdv-body .hljs-template-variable,
.mdv-body .hljs-attr, .mdv-body .hljs-selector-attr, .mdv-body .hljs-selector-pseudo { color: var(--mdv-tk-number); }
.mdv-body .hljs-title, .mdv-body .hljs-title.function_, .mdv-body .hljs-function .hljs-title,
.mdv-body .hljs-section, .mdv-body .hljs-selector-id, .mdv-body .hljs-selector-class { color: var(--mdv-tk-title); }
.mdv-body .hljs-title.class_, .mdv-body .hljs-built_in, .mdv-body .hljs-type, .mdv-body .hljs-class .hljs-title,
.mdv-body .hljs-symbol, .mdv-body .hljs-bullet, .mdv-body .hljs-link { color: var(--mdv-tk-builtin); }
.mdv-body .hljs-tag, .mdv-body .hljs-name, .mdv-body .hljs-attribute { color: var(--mdv-tk-tag); }
.mdv-body .hljs-meta, .mdv-body .hljs-meta .hljs-keyword, .mdv-body .hljs-meta .hljs-string,
.mdv-body .hljs-comment .hljs-doctag { color: var(--mdv-tk-meta); }
.mdv-body .hljs-params, .mdv-body .hljs-punctuation, .mdv-body .hljs-property { color: var(--mdv-tk-punct); }
.mdv-body .hljs-addition { color: var(--mdv-tk-addition); background-color: var(--mdv-tk-addition-bg); display: inline-block; width: 100%; }
.mdv-body .hljs-deletion { color: var(--mdv-tk-deletion); background-color: var(--mdv-tk-deletion-bg); display: inline-block; width: 100%; }
.mdv-body .hljs-emphasis { font-style: italic; }
.mdv-body .hljs-strong { font-weight: 650; }

.mdv-body table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  border-spacing: 0;
  font-size: 0.95em;
  font-variant-numeric: tabular-nums;
}

.mdv-body th, .mdv-body td {
  padding: 0.5em 0.85em;
  border: 1px solid var(--mdv-border);
  text-align: left;
  vertical-align: top;
}

.mdv-body th { font-weight: 650; background-color: var(--mdv-surface); white-space: nowrap; }
.mdv-body tbody tr:nth-child(even) { background-color: var(--mdv-surface-alt); }
.mdv-body th > :last-child, .mdv-body td > :last-child { margin-bottom: 0; }
.mdv-body th[align='left'], .mdv-body td[align='left'] { text-align: left; }
.mdv-body th[align='center'], .mdv-body td[align='center'] { text-align: center; }
.mdv-body th[align='right'], .mdv-body td[align='right'] { text-align: right; }

::selection { background-color: var(--mdv-selection); }

/* Printing an export is a first-class use of it, so the same light-palette
   override the viewer applies is carried over verbatim. */
@media print {
  :root[data-mdv-theme='light'], :root[data-mdv-theme='dark'] {
    color-scheme: light;
    --mdv-bg: #ffffff;
    --mdv-surface: #f6f8fa;
    --mdv-surface-alt: #ffffff;
    --mdv-fg: #111418;
    --mdv-fg-muted: #4c555f;
    --mdv-border: #c4ccd4;
    --mdv-border-strong: #9aa4ae;
    --mdv-accent: #0a3f92;
    --mdv-visited: #0a3f92;
    --mdv-mark-bg: #fff3c4;
    --mdv-tk-keyword: #8f1a24;
    --mdv-tk-string: #0a3069;
    --mdv-tk-comment: #4f5862;
    --mdv-tk-number: #04408a;
    --mdv-tk-title: #5c2ba3;
    --mdv-tk-builtin: #6f2a00;
    --mdv-tk-tag: #0b4a20;
    --mdv-tk-meta: #4c555f;
    --mdv-tk-punct: #3a434c;
    --mdv-tk-addition: #0b4a20;
    --mdv-tk-addition-bg: #eefaf1;
    --mdv-tk-deletion: #711018;
    --mdv-tk-deletion-bg: #fdeeed;
  }

  html, body { background: #ffffff; }

  .mdv-body { max-width: none; padding: 0; font-size: 11pt; }

  .mdv-body pre, .mdv-body blockquote, .mdv-body table, .mdv-body tr,
  .mdv-body img, .mdv-body figure, .mdv-body details { break-inside: avoid; }

  .mdv-body pre { white-space: pre-wrap; overflow-x: visible; }
  .mdv-body table { display: table; width: 100%; overflow-x: visible; }

  .mdv-body h1, .mdv-body h2, .mdv-body h3,
  .mdv-body h4, .mdv-body h5, .mdv-body h6 { break-after: avoid; break-inside: avoid; }
}
`;

function normalizeTheme(theme: string | undefined): ExportTheme {
  return theme === 'dark' ? 'dark' : 'light';
}

/**
 * The reader's typography as a `:root` block.
 *
 * Nothing the document controls reaches this string: the font family and the
 * measure are looked up in constant records rather than interpolated, and the
 * two numbers are clamped and re-stringified. A stylesheet is executable enough
 * to be worth treating like one.
 */
function typographyBlock(typography: ExportTypography | undefined): string {
  const declarations = [
    `--mdv-font-body: ${FONT_STACKS[typography?.fontFamily ?? 'system'] ?? FONT_STACKS.system}`,
    `--mdv-measure: ${CONTENT_WIDTH_CH[typography?.contentWidth ?? 'normal'] ?? CONTENT_WIDTH_CH.normal}`,
  ];

  const size = Number(typography?.fontSize);
  if (Number.isFinite(size)) {
    declarations.push(`--mdv-font-size: ${Math.min(72, Math.max(8, size))}px`);
  }

  const leading = Number(typography?.lineHeight);
  if (Number.isFinite(leading)) {
    declarations.push(`--mdv-line-height: ${Math.min(4, Math.max(1, leading))}`);
  }

  return `:root {\n  ${declarations.join(';\n  ')};\n}`;
}

/**
 * One self-contained file: no stylesheet link, no font URL, no script, and —
 * once the images are embedded — nothing at all to request.
 *
 * `bodyHtml` is already-sanitized markdown output taken back out of the live
 * DOM. Everything else that lands in the file is escaped or looked up, because
 * the title comes from the document and the document is untrusted.
 */
export function buildHtmlDocument(options: {
  title: string;
  bodyHtml: string;
  theme?: string;
  typography?: ExportTypography;
}): string {
  const theme = normalizeTheme(options.theme);

  return [
    '<!doctype html>',
    `<html lang="en" data-mdv-theme="${theme}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="Markdown Viewer">',
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${EXPORT_CSS}\n${typographyBlock(options.typography)}\n</style>`,
    '</head>',
    '<body>',
    `<main class="mdv-body">${options.bodyHtml}</main>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* DOCX — the intermediate representation                                      */
/* -------------------------------------------------------------------------- */

/**
 * The DOM is mapped to blocks and runs first, and only then to docx objects.
 *
 * The split exists so the interesting half is testable: `planDocument` is a pure
 * function from an element to plain data, and every claim about nesting, list
 * numbering, formatting and degradation can be asserted on that data without
 * opening Word or unzipping a package.
 */
export interface DocxRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  underline?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  highlight?: boolean;
  /** Monospaced. Covers `code`, `samp`, `kbd`, and TeX that has no other home. */
  code?: boolean;
  link?: string;
  /** A hard line break; `text` is empty. */
  break?: boolean;
  /** An embedded image. `text` is the alt text, used if it cannot be written. */
  image?: ImageSnapshot;
}

export type DocxAlign = 'left' | 'center' | 'right';

export interface DocxCell {
  header: boolean;
  align: DocxAlign;
  blocks: DocxBlock[];
}

export interface DocxRow {
  cells: DocxCell[];
}

export type DocxBlock =
  | { kind: 'heading'; level: number; runs: DocxRun[] }
  | {
      kind: 'paragraph';
      runs: DocxRun[];
      style?: 'quote' | 'caption';
      align?: DocxAlign;
      indent?: number;
    }
  | { kind: 'list-item'; runs: DocxRun[]; ordered: boolean; level: number; instance: number }
  | { kind: 'code'; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'table'; rows: DocxRow[] };

type RunFormat = Omit<DocxRun, 'text' | 'break' | 'image'>;

/** Tags that live inside a paragraph rather than starting one. */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn',
  'em', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'math', 'picture',
  'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong',
  'sub', 'sup', 'svg', 'time', 'tt', 'u', 'var', 'wbr',
]);

/** Tags that only change how their text is drawn. */
const RUN_FORMATS: Record<string, RunFormat> = {
  b: { bold: true },
  strong: { bold: true },
  em: { italics: true },
  i: { italics: true },
  cite: { italics: true },
  dfn: { italics: true },
  var: { italics: true },
  del: { strike: true },
  s: { strike: true },
  strike: { strike: true },
  ins: { underline: true },
  u: { underline: true },
  sup: { superScript: true },
  sub: { subScript: true },
  mark: { highlight: true },
  code: { code: true },
  samp: { code: true },
  kbd: { code: true },
  tt: { code: true },
};

interface PlanContext {
  /** Inside a blockquote, so paragraphs take the quote style. */
  quote: boolean;
  /** Extra left indent in list-ish steps, for block content nested in an item. */
  indent: number;
  /** Column alignment, when planning the inside of a table cell. */
  align?: DocxAlign;
  /** The ordered-list numbering instance the current list belongs to. */
  instance: number;
  /** Handed out per top-level ordered list, so the next one restarts at 1. */
  counter: { next: number };
}

function newContext(): PlanContext {
  return { quote: false, indent: 0, instance: 0, counter: { next: 0 } };
}

function isInlineNode(node: Node): boolean {
  if (node.nodeType === TEXT_NODE) return true;
  return isElement(node) && INLINE_TAGS.has(tagOf(node));
}

function isBlank(run: DocxRun): boolean {
  return !run.image && !run.break && run.text.trim() === '';
}

/** Drops the indentation whitespace that separates tags in rendered HTML. */
function trimRuns(runs: DocxRun[]): DocxRun[] {
  const kept = runs.filter((run) => run.image || run.break || run.text !== '');

  while (kept.length > 0 && isBlank(kept[0])) kept.shift();
  while (kept.length > 0 && isBlank(kept[kept.length - 1])) kept.pop();

  if (kept.length > 0) {
    if (!kept[0].image) kept[0] = { ...kept[0], text: kept[0].text.replace(/^ +/, '') };
    const last = kept.length - 1;
    if (!kept[last].image) kept[last] = { ...kept[last], text: kept[last].text.replace(/ +$/, '') };
  }

  return kept;
}

function texOf(math: Element): string {
  const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
  return (annotation?.textContent ?? math.textContent ?? '').trim();
}

function snapshotFromElement(image: Element): ImageSnapshot | null {
  const src = image.getAttribute('src') ?? '';
  if (!src.startsWith('data:')) return null;

  const width = Number(image.getAttribute('width'));
  const height = Number(image.getAttribute('height'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { dataUrl: src, mime: dataUrlMime(src), width, height };
}

function collectRuns(node: Node, format: RunFormat, out: DocxRun[]): void {
  if (node.nodeType === TEXT_NODE) {
    // Rendered HTML is full of newlines and indentation that a browser collapses
    // to a single space. Word would keep every one of them.
    const text = (node.nodeValue ?? '').replace(/\s+/g, ' ');
    if (text) out.push({ ...format, text });
    return;
  }

  if (!isElement(node)) return;
  const tag = tagOf(node);

  switch (tag) {
    case 'br':
      out.push({ ...format, text: '', break: true });
      return;

    case 'img': {
      const alt = node.getAttribute('alt')?.trim();
      const snapshot = snapshotFromElement(node);
      out.push({
        ...format,
        // The alt text is what a reader sees if the image cannot be written.
        text: alt || '[image]',
        ...(snapshot ? { image: snapshot } : {}),
      });
      return;
    }

    case 'input':
      // GFM task lists. Word has a checkbox content control, but a character
      // renders identically everywhere and cannot be accidentally ticked.
      // No trailing space: GFM emits one in the text node that follows.
      if (node.getAttribute('type') === 'checkbox') {
        out.push({ ...format, text: node.hasAttribute('checked') ? '☒' : '☐' });
      }
      return;

    case 'svg':
      // A mermaid diagram, or an icon. There is no faithful way to carry vector
      // graphics into the package here, so say what was lost instead.
      out.push({ ...format, italics: true, text: '[diagram]' });
      return;

    case 'math': {
      // MathML has no Word equivalent that survives round-tripping. The TeX the
      // formula was written as is the most useful thing left.
      const tex = texOf(node);
      if (tex) out.push({ ...format, code: true, text: tex });
      return;
    }

    case 'a': {
      const href = node.getAttribute('href') ?? '';
      // A bare fragment points into a page that no longer exists once the
      // document is a .docx. The text stays; only the link is dropped.
      const link = href && !href.startsWith('#') ? href : undefined;
      for (const child of Array.from(node.childNodes)) {
        collectRuns(child, { ...format, ...(link ? { link } : {}) }, out);
      }
      return;
    }

    default: {
      const merged = { ...format, ...RUN_FORMATS[tag] };
      for (const child of Array.from(node.childNodes)) collectRuns(child, merged, out);
    }
  }
}

function inlineRuns(element: Element, format: RunFormat = {}): DocxRun[] {
  const out: DocxRun[] = [];
  for (const child of Array.from(element.childNodes)) collectRuns(child, format, out);
  return trimRuns(out);
}

function paragraph(
  runs: DocxRun[],
  ctx: PlanContext,
  style?: 'quote' | 'caption',
): DocxBlock {
  const resolved = style ?? (ctx.quote ? 'quote' : undefined);

  return {
    kind: 'paragraph',
    runs,
    ...(resolved ? { style: resolved } : {}),
    ...(ctx.align ? { align: ctx.align } : {}),
    ...(ctx.indent ? { indent: ctx.indent } : {}),
  };
}

function codeLines(pre: Element): string[] {
  const code = pre.querySelector('code') ?? pre;
  return (code.textContent ?? '').replace(/\n+$/, '').split('\n');
}

function planTable(table: Element, ctx: PlanContext): DocxBlock[] {
  const rows: DocxRow[] = [];

  for (const row of Array.from(table.querySelectorAll('tr'))) {
    const cells: DocxCell[] = [];

    for (const cell of Array.from(row.children)) {
      const tag = tagOf(cell);
      if (tag !== 'th' && tag !== 'td') continue;

      const declared = cell.getAttribute('align');
      const align: DocxAlign =
        declared === 'center' || declared === 'right' ? declared : 'left';

      cells.push({
        header: tag === 'th',
        align,
        // Cells are planned like any other container, so a list or a code block
        // inside one keeps its structure instead of flattening to a line.
        blocks: planChildren(cell, { ...ctx, quote: false, indent: 0, align }),
      });
    }

    if (cells.length > 0) rows.push({ cells });
  }

  return rows.length > 0 ? [{ kind: 'table', rows }] : [];
}

function planListItem(
  item: Element,
  ctx: PlanContext,
  ordered: boolean,
  level: number,
): DocxBlock[] {
  const out: DocxBlock[] = [];
  const after: DocxBlock[] = [];
  const lead: DocxRun[] = [];
  let emitted = false;
  // Once the item's own line is settled, everything else becomes a block under
  // it rather than more text on it.
  let leadClosed = false;

  const emit = () => {
    if (emitted) return;
    emitted = true;
    out.push({
      kind: 'list-item',
      runs: trimRuns(lead),
      ordered,
      level,
      instance: ctx.instance,
    });
  };

  for (const child of Array.from(item.childNodes)) {
    const tag = isElement(child) ? tagOf(child) : '';

    if (tag === 'ul' || tag === 'ol') {
      emit();
      leadClosed = true;
      after.push(...planList(child as Element, ctx, tag === 'ol', level + 1));
      continue;
    }

    if (!leadClosed && isInlineNode(child)) {
      collectRuns(child, {}, lead);
      continue;
    }

    // A loose list wraps the item's text in a <p>; that first paragraph is still
    // the item itself, not a block hanging under it.
    if (!leadClosed && tag === 'p' && lead.length === 0) {
      collectRuns(child, {}, lead);
      leadClosed = true;
      continue;
    }

    emit();
    leadClosed = true;
    after.push(...planNode(child, { ...ctx, indent: level + 1 }));
  }

  emit();
  out.push(...after);
  return out;
}

function planList(
  list: Element,
  ctx: PlanContext,
  ordered: boolean,
  level: number,
): DocxBlock[] {
  // A fresh numbering instance per top-level ordered list. Sharing one would
  // make the second list in a document continue from where the first stopped.
  const instance = ordered && level === 0 ? ctx.counter.next++ : ctx.instance;
  const inner: PlanContext = { ...ctx, instance };

  return Array.from(list.children).flatMap((child) =>
    tagOf(child) === 'li'
      ? planListItem(child, inner, ordered, level)
      : planNode(child, inner),
  );
}

function planNode(node: Node, ctx: PlanContext): DocxBlock[] {
  if (node.nodeType === TEXT_NODE) {
    const runs = trimRuns([{ text: (node.nodeValue ?? '').replace(/\s+/g, ' ') }]);
    return runs.length > 0 ? [paragraph(runs, ctx)] : [];
  }

  if (!isElement(node)) return [];
  const tag = tagOf(node);

  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    return [{ kind: 'heading', level: Number(heading[1]), runs: inlineRuns(node) }];
  }

  switch (tag) {
    case 'p':
      return [paragraph(inlineRuns(node), ctx)];

    case 'pre':
      return [{ kind: 'code', lines: codeLines(node) }];

    case 'blockquote':
      return planChildren(node, { ...ctx, quote: true });

    case 'ul':
      return planList(node, ctx, false, 0);

    case 'ol':
      return planList(node, ctx, true, 0);

    case 'hr':
      return [{ kind: 'rule' }];

    case 'table':
      return planTable(node, ctx);

    case 'figcaption':
      return [paragraph(inlineRuns(node), ctx, 'caption')];

    // A definition term and a disclosure summary are both headings for something
    // that is not a heading. Bold text is the honest equivalent.
    case 'dt':
    case 'summary':
      return [paragraph(inlineRuns(node, { bold: true }), ctx)];

    case 'dd':
      return planChildren(node, { ...ctx, indent: ctx.indent + 1 });

    case 'script':
    case 'style':
    case 'template':
      return [];

    default:
      // Anything else — div, section, figure, details, dl, or a tag markdown
      // does not produce — is a container. Recursing means unknown markup
      // degrades to its text rather than disappearing.
      return planChildren(node, ctx);
  }
}

function planChildren(parent: Element, ctx: PlanContext): DocxBlock[] {
  const out: DocxBlock[] = [];
  let buffer: DocxRun[] = [];

  const flush = () => {
    const runs = trimRuns(buffer);
    buffer = [];
    if (runs.length > 0) out.push(paragraph(runs, ctx));
  };

  for (const child of Array.from(parent.childNodes)) {
    // Consecutive inline nodes are one paragraph, not one paragraph each.
    if (isInlineNode(child)) {
      collectRuns(child, {}, buffer);
      continue;
    }

    flush();
    out.push(...planNode(child, ctx));
  }

  flush();
  return out;
}

/**
 * Maps a cleaned document to blocks. Expects the output of `cleanForExport`:
 * chrome removed, images embedded as `data:` URLs with their dimensions on the
 * element, and KaTeX reduced to MathML.
 */
export function planDocument(root: Element): DocxBlock[] {
  return planChildren(root, newContext());
}

/* -------------------------------------------------------------------------- */
/* DOCX — building the package                                                 */
/* -------------------------------------------------------------------------- */

const CODE_FONT = 'Consolas';
const QUOTE_STYLE = 'mdvQuote';
const CODE_STYLE = 'mdvCode';
const CAPTION_STYLE = 'mdvCaption';
const ORDERED_REFERENCE = 'mdv-ordered';

/** One indent step, in twips. Word's own list indent. */
const INDENT_STEP = 360;

/** Widest an image may be placed, in px at 96 dpi — a 6" text column. */
const MAX_IMAGE_WIDTH_PX = 576;

/** Deepest level Word's list styles are configured for here. */
const MAX_LIST_LEVEL = 4;

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const ALIGNMENTS: Record<DocxAlign, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
};

/** The raster formats `ImageRun` accepts without a fallback image. */
const DOCX_IMAGE_TYPES: Record<string, 'png' | 'jpg' | 'gif' | 'bmp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

interface BuildReport {
  skippedImages: number;
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  // Only base64 payloads. A `data:image/svg+xml,<svg…>` URL is text, and it is
  // not a format that would be accepted below anyway.
  if (comma < 0 || !/;base64/i.test(dataUrl.slice(0, comma))) return null;

  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function toImageRun(run: DocxRun): ImageRun | null {
  const snapshot = run.image;
  if (!snapshot) return null;

  const type = DOCX_IMAGE_TYPES[snapshot.mime];
  if (!type) return null;

  const data = dataUrlToBytes(snapshot.dataUrl);
  if (!data) return null;

  // Word places images at their pixel size, so an unscaled screenshot runs off
  // the page. Only ever shrink — upscaling a small icon would look worse.
  const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / snapshot.width);

  return new ImageRun({
    type,
    data,
    transformation: {
      width: Math.max(1, Math.round(snapshot.width * scale)),
      height: Math.max(1, Math.round(snapshot.height * scale)),
    },
    altText: run.text ? { name: run.text, description: run.text, title: run.text } : undefined,
  });
}

function toTextRun(run: DocxRun): TextRun {
  return new TextRun({
    text: run.text,
    // A `<br>` is a break *before* the (empty) text of this run.
    break: run.break ? 1 : undefined,
    bold: run.bold,
    italics: run.italics,
    strike: run.strike,
    underline: run.underline ? { type: UnderlineType.SINGLE } : undefined,
    superScript: run.superScript,
    subScript: run.subScript,
    highlight: run.highlight ? 'yellow' : undefined,
    font: run.code ? CODE_FONT : undefined,
    style: run.link ? 'Hyperlink' : undefined,
  });
}

function toChildren(runs: DocxRun[], report: BuildReport): ParagraphChild[] {
  const out: ParagraphChild[] = [];

  for (const run of runs) {
    if (run.image) {
      const image = toImageRun(run);
      if (image) {
        out.push(image);
        continue;
      }
      // Falls through to the alt text below: an image Word cannot hold still
      // leaves a mark on the page, and the caller reports the count.
      report.skippedImages += 1;
    }

    const text = toTextRun(run);
    out.push(run.link ? new ExternalHyperlink({ link: run.link, children: [text] }) : text);
  }

  return out;
}

function toCell(cell: DocxCell, report: BuildReport): TableCell {
  const children = cell.blocks.flatMap((block) => toDocxElements(block, report));

  return new TableCell({
    // A cell may not be empty in OOXML; an empty paragraph is the placeholder.
    children: children.length > 0 ? children : [new Paragraph({ children: [] })],
    shading: cell.header ? { fill: 'F2F2F2' } : undefined,
  });
}

function toDocxElements(block: DocxBlock, report: BuildReport): (Paragraph | Table)[] {
  switch (block.kind) {
    case 'heading':
      // A real Word heading style, not bold text — it is what populates the
      // navigation pane and any table of contents the reader inserts later.
      return [
        new Paragraph({
          heading: HEADING_LEVELS[Math.min(block.level, HEADING_LEVELS.length) - 1],
          children: toChildren(block.runs, report),
        }),
      ];

    case 'paragraph': {
      const options: IParagraphOptions = {
        children: toChildren(block.runs, report),
        style:
          block.style === 'quote'
            ? QUOTE_STYLE
            : block.style === 'caption'
              ? CAPTION_STYLE
              : undefined,
        alignment: block.align ? ALIGNMENTS[block.align] : undefined,
        indent: block.indent ? { left: INDENT_STEP * block.indent } : undefined,
      };
      return [new Paragraph(options)];
    }

    case 'list-item': {
      const level = Math.min(block.level, MAX_LIST_LEVEL);
      return [
        new Paragraph({
          children: toChildren(block.runs, report),
          ...(block.ordered
            ? { numbering: { reference: ORDERED_REFERENCE, level, instance: block.instance } }
            : { bullet: { level } }),
        }),
      ];
    }

    case 'code':
      // One paragraph per line: a Word paragraph has no newline to hold, and
      // the style keeps them visually a single block.
      return block.lines.map(
        (line) =>
          new Paragraph({ style: CODE_STYLE, children: [new TextRun({ text: line })] }),
      );

    case 'rule':
      return [
        new Paragraph({
          children: [],
          spacing: { before: 120, after: 120 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '9AA4AE' } },
        }),
      ];

    case 'table':
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.rows.map(
            (row) =>
              new TableRow({
                // Repeats across a page break, which is what a reader expects
                // from a header row and what Word will not infer on its own.
                tableHeader: row.cells.every((cell) => cell.header),
                children: row.cells.map((cell) => toCell(cell, report)),
              }),
          ),
        }),
      ];
  }
}

/** Numbering for ordered lists, one configured level per supported depth. */
const ORDERED_LEVELS = [0, 1, 2, 3, 4].map((level) => ({
  level,
  format: LevelFormat.DECIMAL,
  text: `%${level + 1}.`,
  alignment: AlignmentType.START,
  style: {
    paragraph: {
      indent: { left: INDENT_STEP * 2 * (level + 1), hanging: INDENT_STEP },
    },
  },
}));

export function buildDocxDocument(
  blocks: DocxBlock[],
  options: { title: string },
): { document: WordDocument; skippedImages: number } {
  const report: BuildReport = { skippedImages: 0 };
  const children = blocks.flatMap((block) => toDocxElements(block, report));

  const document = new WordDocument({
    title: options.title,
    description: 'Exported by Markdown Viewer',
    styles: {
      paragraphStyles: [
        {
          id: CODE_STYLE,
          name: 'Markdown Code',
          basedOn: 'Normal',
          next: CODE_STYLE,
          run: { font: CODE_FONT, size: 18 },
          paragraph: {
            spacing: { before: 0, after: 0 },
            shading: { fill: 'F4F4F4' },
            indent: { left: INDENT_STEP },
          },
        },
        {
          id: QUOTE_STYLE,
          name: 'Markdown Quote',
          basedOn: 'Normal',
          next: 'Normal',
          run: { italics: true, color: '4C555F' },
          paragraph: {
            indent: { left: INDENT_STEP },
            border: {
              left: { style: BorderStyle.SINGLE, size: 12, color: '9AA4AE', space: 12 },
            },
          },
        },
        {
          id: CAPTION_STYLE,
          name: 'Markdown Caption',
          basedOn: 'Normal',
          next: 'Normal',
          run: { italics: true, size: 18, color: '4C555F' },
          paragraph: { alignment: AlignmentType.CENTER },
        },
      ],
    },
    numbering: { config: [{ reference: ORDERED_REFERENCE, levels: ORDERED_LEVELS }] },
    sections: [{ children }],
  });

  return { document, skippedImages: report.skippedImages };
}
