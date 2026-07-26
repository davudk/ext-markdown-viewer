/**
 * Hover previews, decided.
 *
 * Everything in this module is a decision rather than an effect: which links
 * are previewable, which path a relative link names inside the open folder,
 * what a preview shows, and where it is put when the browser will not put it
 * there for us. Nothing here touches the network, opens a popover, or reads
 * `window` — which is what makes the interesting half testable under the bare
 * runner, where the Popover API does not exist and nothing has a layout.
 *
 * **Nothing is ever fetched.** The one classification that matters is the one
 * that refuses: an `http(s)` link — same host or not — is never previewed,
 * because the only way to know what it points at would be to request it, and
 * requesting it would tell that host what the reader is reading. This extension
 * does not make requests, so previews are limited to text it already has: the
 * rendered document itself, and files the reader handed over through a folder
 * handle. See `lib/links.ts`, which refuses on the same grounds.
 */

import { FOLDER_DOCUMENT_SCHEME, MARKDOWN_EXTENSIONS } from '../../lib/config.ts';
import { classifyLink } from '../../lib/links.ts';
import { slugify } from '../../lib/slug.ts';

/** Marks a link this plugin has claimed; the value is the kind. */
export const CLAIMED = 'data-mdv-preview';

/**
 * How long the pointer has to rest before a preview appears.
 *
 * The delay is the feature. Firing on the first `mouseover` turns skimming a
 * paragraph of footnote references into a strobe of popovers appearing and
 * vanishing under the pointer, which is worse than no preview at all.
 */
export const HOVER_DELAY_MS = 300;

/** Roughly the target block plus the next two. */
export const PREVIEW_BLOCKS = 3;

export type PreviewKind =
  /** `#fn1`, `#some-heading`: somewhere in the document already on screen. */
  | 'fragment'
  /** A relative markdown sibling — only readable through a folder handle. */
  | 'file';

/** `scheme:` or a protocol-relative `//host`. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * What, if anything, this link can be previewed from — and `null` for every
 * link that would need a request.
 *
 * Four kinds qualify, and they are the four whose content is already in hand:
 * footnote references and in-document anchors (both plain fragments), relative
 * file links, and wikilinks — which the markdown pipeline has already turned
 * into relative file links by the time this sees them, so they need no case of
 * their own.
 *
 * Everything else is `null`, and `http(s)` is `null` *emphatically*: an
 * absolute address, even one on the document's own host, can only be previewed
 * by fetching it. `classifyLink` is consulted as well so that an exotic scheme
 * this function has no opinion about cannot slip through as "relative".
 */
export function previewKind(href: string, documentUrl: string): PreviewKind | null {
  const target = href.trim();
  if (!target) return null;

  // Checked before parsing: resolving `#x` yields the document's own address,
  // which would look like an ordinary internal link.
  if (target.startsWith('#')) return target.length > 1 ? 'fragment' : null;

  // An address rather than a path. `https:` and `http:` land here, and so do
  // `mailto:`, `file:` and anything else naming a scheme. None of them can be
  // read without leaving the page, so none of them are previewed.
  if (ABSOLUTE.test(target)) return null;

  // A relative href cannot be `external`, but it can be nonsense; a link that
  // does not classify as part of this document is not one we reason about.
  //
  // A document opened through a directory handle is exempt, and has to be:
  // `mdv-folder:Root/a.md` is an opaque-path URL, so resolving a relative href
  // against it throws and every such link would classify as `unknown`. There is
  // no host to leave in the first place — a relative path under that scheme is
  // a path inside the folder the reader granted, and nothing else.
  if (!documentUrl.startsWith(FOLDER_DOCUMENT_SCHEME)) {
    const kind = classifyLink(target, documentUrl);
    if (kind !== 'internal' && kind !== 'fragment') return null;
  }

  const path = pathOf(target);
  if (!path) return 'fragment';

  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension))
    ? 'file'
    : null;
}

/** The path part of an href, percent-decoding what the renderer encoded. */
export function pathOf(href: string): string {
  const path = href.split(/[?#]/)[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** The fragment of an href, decoded, without its `#`. */
export function fragmentOf(href: string): string {
  const hash = href.indexOf('#');
  if (hash === -1) return '';
  try {
    return decodeURIComponent(href.slice(hash + 1));
  } catch {
    return href.slice(hash + 1);
  }
}

/**
 * Where `href` lands, as a path inside the open folder.
 *
 * Pure string work over the same `a/b/c` paths `lib/folder.ts` mints. A target
 * that climbs above the folder root is `null` rather than clamped: the reader
 * granted a handle to one directory, and a preview is not a reason to go
 * looking outside it.
 */
export function resolveFolderPath(currentPath: string, href: string): string | null {
  const path = pathOf(href);
  if (!path) return null;

  const segments = path.startsWith('/')
    ? []
    : currentPath.split('/').slice(0, -1).filter(Boolean);

  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }

  return segments.length > 0 ? segments.join('/') : null;
}

/* -------------------------------------------------------------------------- */
/* What a preview shows — in this document                                     */
/* -------------------------------------------------------------------------- */

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * The blocks a preview of `target` is made of.
 *
 * A heading previews its section: the heading plus what follows it, stopping at
 * the next heading of the same rank or higher, because running past it would
 * show the reader a different section than the one they pointed at. Anything
 * else — a footnote's list item, a paragraph — previews itself and its
 * neighbours under the same cap.
 */
export function previewBlocks(target: Element, limit = PREVIEW_BLOCKS): Element[] {
  const blocks: Element[] = [target];
  const level = headingLevel(target);

  // A footnote is one item and reads as one; walking into the *next* footnote
  // would be showing a reference the reader did not point at.
  if (target.tagName === 'LI') return blocks;

  let node = target.nextElementSibling;
  while (node && blocks.length < limit) {
    const next = headingLevel(node);
    if (next > 0 && (level === 0 || next <= level)) break;
    blocks.push(node);
    node = node.nextElementSibling;
  }

  return blocks;
}

function headingLevel(element: Element): number {
  return HEADINGS.has(element.tagName) ? Number(element.tagName[1]) : 0;
}

/**
 * Attributes stripped from every cloned node.
 *
 * `id` first and for correctness: the body is the live document, so a clone
 * carrying its source's id would give the page two elements answering to
 * `#installation` — and the second one is inside a preview that is about to be
 * thrown away. The rest is the accessibility rule: a preview is supplementary,
 * so nothing inside it is focusable, activatable or announced as a control.
 */
const STRIPPED = ['id', 'tabindex', 'role', 'href', 'name', 'aria-label', 'popover'];

/**
 * A detached, inert copy of the blocks.
 *
 * Cloned rather than re-rendered: the body has already been through DOMPurify,
 * and re-parsing the markdown to show two paragraphs would be a second pipeline
 * that could disagree with the first.
 */
export function cloneBlocks(blocks: readonly Element[]): DocumentFragment {
  const owner = blocks[0]?.ownerDocument;
  const fragment = owner!.createDocumentFragment();

  for (const block of blocks) {
    const copy = block.cloneNode(true) as Element;
    sanitizeClone(copy);
    fragment.append(copy);
  }

  return fragment;
}

function sanitizeClone(root: Element): void {
  const nodes = [root, ...root.querySelectorAll('*')];

  for (const node of nodes) {
    for (const attribute of STRIPPED) node.removeAttribute(attribute);
    // Controls another plugin grafted on — a copy button, a fold toggle. They
    // are affordances for the real document, and a dead copy of one is worse
    // than its absence.
    if (node !== root && (node.tagName === 'BUTTON' || node.tagName === 'INPUT')) {
      node.remove();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* What a preview shows — in another file                                      */
/* -------------------------------------------------------------------------- */

/**
 * The opening of `source`, or of the section `fragment` names, as plain text.
 *
 * Text rather than markup on purpose. The other file has not been through the
 * renderer or through DOMPurify, and standing up a second pipeline to show
 * three paragraphs would mean a second place for sanitization to be wrong. A
 * preview is a glance at what is there; opening the file is the way to read it.
 */
export function summarizeSource(
  source: string,
  fragment = '',
  limit = PREVIEW_BLOCKS,
): string[] {
  const lines = withoutFrontMatter(source).split(/\r?\n/);
  let start = 0;

  if (fragment) {
    const index = lines.findIndex((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
      return heading !== null && slugify(heading[1]) === fragment;
    });
    // A fragment that names nothing shows the file's opening rather than
    // nothing at all: the link still points at a file that exists.
    if (index >= 0) start = index;
  }

  const blocks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    const text = current.join(' ').trim();
    current = [];
    if (text) blocks.push(text);
  };

  for (const line of lines.slice(start)) {
    if (!line.trim()) {
      flush();
      if (blocks.length >= limit) break;
      continue;
    }
    current.push(line.trim());
  }
  if (blocks.length < limit) flush();

  return blocks.slice(0, limit);
}

/** Everything after a leading `---` block, which is metadata rather than prose. */
function withoutFrontMatter(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

/* -------------------------------------------------------------------------- */
/* Where it goes, when the browser will not decide                             */
/* -------------------------------------------------------------------------- */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Which side of the link the preview ended up on. */
  side: 'above' | 'below';
}

/**
 * Viewport coordinates for a preview of `size` beside `anchor`.
 *
 * This is the fallback path's whole job, and it is arithmetic so that it can be
 * asserted without a layout engine. Below the link is the default because that
 * is where the eye already is; above only when below genuinely does not fit and
 * above does. Horizontally the preview is pulled back inside the viewport
 * rather than flipped, since a 400px box aligned to a link near the right edge
 * is readable shifted and unreadable clipped.
 */
export function decidePlacement(
  anchor: Box,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  gap = 8,
  margin = 8,
): Placement {
  const below = viewport.height - (anchor.top + anchor.height) - gap;
  const above = anchor.top - gap;
  const side: Placement['side'] =
    below >= size.height || below >= above ? 'below' : 'above';

  const top =
    side === 'below' ? anchor.top + anchor.height + gap : anchor.top - gap - size.height;

  const widest = Math.max(margin, viewport.width - size.width - margin);
  const left = Math.min(Math.max(anchor.left, margin), widest);

  return {
    left,
    // Clamped so a preview taller than the space it was given still starts on
    // screen; the fade at its bottom edge is what says there is more.
    top: Math.max(margin, top),
    side,
  };
}
