/**
 * `[[Page Name]]`, `[[Page|Label]]`, `[[Page#Heading]]`.
 *
 * Hand-rolled rather than taken from markdown-it-wikilinks, which cannot run
 * here: it reaches `markdown-it-regexp`, which calls node's `util.inherits` at
 * module scope, so the bundled renderer throws before it renders a character.
 * The dependency was removed rather than shimmed.
 *
 * The rule is installed `before('link')` — `link` is markdown-it core, always
 * present, and also opens on `[`, so it would otherwise get first look at
 * `[[…]]`. Ordering against a core rule by name means no registry position can
 * break it.
 *
 * This is also the seam. A wikilink becomes an ordinary *relative* href, which
 * is the one form the browser resolves correctly for a `file://` note, a raw
 * host and a served folder alike; `lib/links.ts` leaves it unmarked because it
 * does not leave the document's own directory. What it deliberately does not do
 * is consult the folder browser: a document opened through a directory handle
 * has no URL to resolve against (`FOLDER_DOCUMENT_SCHEME` in config.ts), so
 * teaching these links to walk a `FileSystemDirectoryHandle` belongs in
 * `lib/folder.ts` next to the rest of that plumbing, not here.
 *
 * Disabled, `[[Page]]` is four brackets and a word.
 */

import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

import { MARKDOWN_EXTENSIONS } from '../../lib/config.ts';

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
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { slugify } from '../../lib/slug.ts';

const BRACKET = 0x5b; /* [ */

/** `scheme:` or a protocol-relative `//host`. */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function wikilink(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (
    state.src.charCodeAt(start) !== BRACKET ||
    state.src.charCodeAt(start + 1) !== BRACKET
  ) {
    return false;
  }

  const end = state.src.indexOf(']]', start + 2);
  if (end === -1 || end + 2 > state.posMax) return false;

  const body = state.src.slice(start + 2, end);
  // A bracket or a line break inside means this was never one link.
  if (!body.trim() || /[[\]\n]/.test(body)) return false;

  const bar = body.indexOf('|');
  const target = (bar === -1 ? body : body.slice(0, bar)).trim();
  const label = (bar === -1 ? target : body.slice(bar + 1).trim()) || target;

  const href = wikilinkHref(target);
  // `normalizeLink` percent-encodes the spaces a real filename has in it;
  // `validateLink` is markdown-it's own refusal of `javascript:` and friends,
  // and this href came out of an untrusted document like any other.
  const normalized = state.md.normalizeLink(href);
  if (!state.md.validateLink(normalized)) return false;

  if (!silent) {
    const open = state.push('link_open', 'a', 1);
    open.attrSet('href', normalized);
    open.attrSet('class', WIKILINK_CLASS);
    // A token rather than interpolated markup, so the label is escaped by the
    // renderer and `[[Tom & Jerry]]` keeps its ampersand.
    state.push('text', '', 0).content = labelWithoutHash(label);
    state.push('link_close', 'a', -1);
  }

  state.pos = end + 2;
  return true;
}

function wikilinkHref(target: string): string {
  const hash = target.indexOf('#');
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  // Headings are addressed by the slugs `lib/slug.ts` mints — the same function
  // `markdown-headings` assigns ids with, which is why it is shared rather than
  // reimplemented on either side.
  const fragment = hash === -1 ? '' : `#${slugify(target.slice(hash + 1))}`;

  // `[[#Section]]` is a link within this document.
  if (!path) return fragment;

  // A target that already names a scheme or a host is an address, not a page:
  // appending `.md` to it would only invent a file nobody has. `validateLink`
  // in the caller is what decides whether the scheme is one we will follow.
  const named =
    ABSOLUTE.test(path) ||
    MARKDOWN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

  return `${path}${named ? '' : WIKILINK_SUFFIX}${fragment}`;
}

/** `[[Page#Heading]]` shows the page, not the anchor. */
function labelWithoutHash(label: string): string {
  return label.startsWith('#') ? label.slice(1) : label.replace(/#[^#]*$/, '');
}

export const markdownWikilinksPlugin: Plugin = {
  id: 'markdown-wikilinks',
  name: 'Wikilinks',
  description: 'Resolves `[[Page Name]]` to a relative markdown sibling.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.inline.ruler.before('link', 'mdv_wikilink', wikilink);
  },
};
