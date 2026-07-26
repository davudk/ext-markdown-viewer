/**
 * Which links in a document lead nowhere — decided from what is already known,
 * never from the network.
 *
 * # The one rule that shapes everything here
 *
 * **A false positive is worse than a miss.** A dotted underline under a link
 * that is actually fine is a lie about someone's document, and a reader who
 * finds one stops trusting every other mark on the page. A link this module
 * cannot decide about is therefore left alone, silently, and there are a lot of
 * those — see `SKIPPED` at the bottom of this file for the full list.
 *
 * # Never the network
 *
 * `http(s)` links are **never** checked. It is tempting — a `HEAD` request per
 * link would catch far more — and it is exactly the thing this extension exists
 * not to do: probing every link in a README would leak the reader's reading
 * list to every host the document mentions. `lib/links.ts` says the same thing
 * at the top of the file, and `scripts/audit-network.mjs` fails the build for
 * anything that could open a connection. There is no `fetch` here and there
 * must never be one.
 *
 * Pure string and DOM-query work, no React and no plugin context, so the whole
 * decision is testable without a host.
 */

import { classifyLink } from '../../lib/links.ts';
import { isMarkdownName } from '../../lib/folder.ts';

/** Attribute the stylesheet keys the marker off, valued with which tier found it. */
export const BROKEN_LINK_ATTRIBUTE = 'data-mdv-broken';

export type BrokenTier = 'anchor' | 'file';

/** One link that leads nowhere, and why we are willing to say so. */
export interface BrokenLink {
  /** The href exactly as the document wrote it. */
  href: string;
  /** The link's own text, for the list. Empty for an image-only link. */
  text: string;
  tier: BrokenTier;
  /** Shown in the tooltip and in the list. A sentence, not a code. */
  reason: string;
  element: HTMLAnchorElement;
}

/* -------------------------------------------------------------------------- */
/* Tier 1 — anchors                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every `#heading` link whose target id is not in the document.
 *
 * The ids come from `ctx.document.headings`, which is what `lib/markdown.ts`
 * actually assigned — not a slug re-derived here. That matters more than it
 * looks: the slugger dedupes (`options`, `options-1`) and strips punctuation in
 * its own way (`Install & setup` → `install--setup`), so a second
 * implementation would disagree with the document on precisely the awkward
 * cases a broken-link checker exists to catch, and it would disagree by
 * inventing breakage that is not there.
 *
 * The DOM is consulted as well as the heading list, because headings are not
 * the only ids in a rendered document: footnotes mint `#fn1` and `#fnref1`, and
 * raw HTML in the source can carry any id it likes. Anything the browser can
 * actually scroll to is not broken, whoever put it there.
 */
export function findBrokenAnchors(
  body: HTMLElement,
  documentUrl: string,
  headingIds: ReadonlySet<string>,
): BrokenLink[] {
  const broken: BrokenLink[] = [];

  for (const link of links(body)) {
    const href = link.getAttribute('href') ?? '';

    // `fragment` is `#…` and the empty href, and nothing else — an http(s)
    // link with a fragment classifies as `external` and is dropped below,
    // which is the whole reason the check is phrased this way round.
    if (classifyLink(href, documentUrl) !== 'fragment') continue;

    const id = fragmentId(href);
    // `#` and `` both mean the top of the document, which always exists.
    if (id === null) continue;

    if (headingIds.has(id)) continue;
    // `#user-content-x` is GitHub's own prefixed duplicate of `#x`. Nothing
    // here mints those, but a document pasted out of a GitHub page carries
    // them, and they are not this checker's business to call wrong.
    if (id.startsWith('user-content-') && headingIds.has(id.slice(13))) continue;
    if (hasElementWithId(body, id)) continue;

    broken.push({
      href,
      text: textOf(link),
      tier: 'anchor',
      reason: `No heading in this document has the id “${id}”.`,
      element: link,
    });
  }

  return broken;
}

/**
 * The id a fragment link points at, decoded, or null when it points at the top.
 *
 * Decoded because the document writes the href and the browser matches on the
 * decoded value: `#caf%C3%A9` and `#café` are the same destination, and a
 * checker that compared the raw string would report the encoded one broken.
 */
export function fragmentId(href: string): string | null {
  const hash = href.indexOf('#');
  const raw = hash === -1 ? '' : href.slice(hash + 1).trim();
  if (raw === '') return null;

  try {
    return decodeURIComponent(raw);
  } catch {
    // A lone `%` is not a decodable escape. Compare what was written.
    return raw;
  }
}

/**
 * Whether anything in the document carries this id.
 *
 * `getElementById` is not usable: the body is an element, not a document, and
 * the id may legitimately be a string `CSS.escape` has to quote (`#3.1`,
 * `#a b`). Attribute-selector form with an escaped value handles both, and the
 * try/catch is for a runtime without `CSS.escape` — jsdom under the bare test
 * runner is one.
 */
function hasElementWithId(body: HTMLElement, id: string): boolean {
  try {
    const escaped = typeof CSS?.escape === 'function' ? CSS.escape(id) : null;
    if (escaped) return body.querySelector(`#${escaped}`) !== null;
  } catch {
    /* fall through to the scan */
  }

  for (const element of body.querySelectorAll('[id]')) {
    if (element.id === id) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Tier 2 — relative files                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What tier 2 is allowed to reason about: the folder tree as far as it has
 * been read.
 *
 * Deliberately not a `FileSystemDirectoryHandle`. The folder browser publishes
 * the markdown files in the directories it has *already* listed, and nothing
 * more — so this checker knows which directories it has seen, and treats
 * everything else as unknown rather than as missing.
 */
export interface FolderKnowledge {
  /** Path of the open document inside the folder, e.g. `docs/guide.md`. */
  documentPath: string;
  /** Relative paths of every markdown file in the directories read so far. */
  paths: ReadonlySet<string>;
  /** Directories whose contents are fully known. `''` is the root. */
  directories: ReadonlySet<string>;
}

/**
 * Relative links whose target is missing from a directory we have fully read.
 *
 * The whole tier hinges on `directories`. A link into a folder nobody has
 * expanded is *unknown*, not broken, and saying otherwise would mark half a
 * documentation site the moment it is opened — the single most damaging false
 * positive this feature could produce.
 */
export function findBrokenRelativeLinks(
  body: HTMLElement,
  documentUrl: string,
  folder: FolderKnowledge,
): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const base = parentOf(folder.documentPath);

  for (const link of links(body)) {
    const href = link.getAttribute('href') ?? '';

    // Stated as a refusal rather than as `=== 'internal'`, because a document
    // opened through a directory handle has a `mdv-folder:` address with an
    // *opaque* path — nothing resolves against it, so every relative link on
    // the page classifies as `unknown` rather than as `internal`, and the
    // positive form would silently switch tier 2 off in exactly the case it
    // exists for. What matters is the refusal, and `external` is in it: an
    // http(s) link must never reach the resolver, let alone the network.
    const kind = classifyLink(href, documentUrl);
    if (kind !== 'internal' && kind !== 'unknown') continue;

    const target = resolveRelative(base, href);
    if (target === null) continue;

    if (folder.paths.has(target)) continue;
    if (!folder.directories.has(parentOf(target))) continue;

    broken.push({
      href,
      text: textOf(link),
      tier: 'file',
      reason: `No file named “${target}” in the open folder.`,
      element: link,
    });
  }

  return broken;
}

/**
 * A relative href as a path inside the open folder, or null when tier 2 has no
 * business deciding.
 *
 * Null is returned far more often than a path, and every one of those is a
 * deliberate miss:
 *
 *   - anything absolute, rooted, or carrying a query — not a sibling file
 *   - a non-markdown target: the folder browser lists markdown only, so an
 *     image or a `.txt` is invisible to us and could never be verified
 *   - a path that walks above the folder root — outside what was opened
 */
export function resolveRelative(baseDirectory: string, href: string): string | null {
  const path = decodePath(href.split(/[?#]/)[0].trim());
  if (path === '' || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return null;
  }
  if (!isMarkdownName(path)) return null;

  const segments = baseDirectory === '' ? [] : baseDirectory.split('/');

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Above the root: the reader opened a folder, not a filesystem.
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments.length === 0 ? null : segments.join('/');
}

/** `docs/a/b.md` → `docs/a`; a file at the root → `''`. */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Percent-decoding, per segment.
 *
 * Wikilinks go through `normalizeLink`, which encodes the spaces a real
 * filename has in it — so `[[Getting Started]]` arrives as `Getting%20Started.md`
 * and has to be compared against `Getting Started.md`.
 */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Links a mark may ever be put on.
 *
 * `[href]` only — a bare `<a name>` is an anchor target, not a link. Nothing
 * else is filtered here: unlike the external-link indicator there is no density
 * limit and no suppression inside headings or tables, because "this link is
 * broken" does not stop being worth saying because it has neighbours.
 */
function links(body: HTMLElement): HTMLAnchorElement[] {
  return [...body.querySelectorAll<HTMLAnchorElement>('a[href]')];
}

function textOf(link: Element): string {
  return (link.textContent ?? '').trim().replace(/\s+/g, ' ');
}

/* Cases that are deliberately never marked, gathered in one place so the
   omissions are a decision on the record rather than gaps someone has to infer:

     `https://…`              never, at any tier — see the header of this file
     `mailto:` `tel:` `sms:`  no destination to check without sending something
     `javascript:` `data:`    sanitization already removed these
     `#` and `""`             the top of the document, which always exists
     `#fn1`, `#anything`      matched against real DOM ids, not just headings
     `./image.png`            the folder index holds markdown only
     `../../outside.md`       above the folder the reader actually opened
     `./unread-dir/x.md`      that directory has not been listed; unknown ≠ gone
     any link, no folder open tier 2 simply does not run
     a document with no       the heading list is unavailable rather than empty,
       headings at all         so tier 1 has nothing to check against
     the raw view             it is one `<pre>`; its "links" are source text */
