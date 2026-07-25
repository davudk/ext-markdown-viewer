/**
 * Where a link goes, decided from the URL alone.
 *
 * Nothing here ever touches the network. A link is classified by resolving it
 * against the document's own address and comparing hosts — no request, no
 * HEAD, no preflight, not even a DNS-shaped guess. That is not an optimization:
 * probing every link in a README would leak the reader's reading list to every
 * host it mentions, which is precisely what this extension exists not to do.
 *
 * The classification half is pure string work so it can be tested without a
 * DOM. The marking half below needs one, but only to walk elements — it reads
 * no layout and makes no measurement.
 */

/** Attribute the stylesheet keys the indicator off. */
export const EXTERNAL_LINK_ATTRIBUTE = 'data-mdv-external';

/**
 * External links per block past which none of them are marked.
 *
 * A badge row, a link table or a bibliography is *made of* outbound links; an
 * arrow on every one of them is texture rather than information, and it is the
 * fastest way to make a document look broken. Below the limit the marker says
 * "this one leaves"; above it, that has stopped being news.
 */
export const EXTERNAL_LINK_DENSITY_LIMIT = 6;

export type LinkKind =
  /** `#section`, or an empty href: the document that is already open. */
  | 'fragment'
  /** Another document reachable the same way this one was. */
  | 'internal'
  /** A different http(s) host — the only kind that gets an indicator. */
  | 'external'
  | 'mail'
  | 'tel'
  /** `javascript:` and friends. Sanitization strips these; classify anyway. */
  | 'unsafe'
  /** Unparseable, or a scheme we have no opinion about. */
  | 'unknown';

/**
 * Resolves `href` against `base`, or against nothing when `base` is unusable.
 *
 * An absolute href still classifies when the document's own address is
 * malformed, which is the case on a few exotic `file://` paths.
 */
function resolve(href: string, base?: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return base === undefined ? null : resolve(href);
  }
}

/**
 * What kind of destination `href` is, seen from a document at `documentUrl`.
 *
 * Hosts are compared including the port: a different port is a different
 * server, whatever the hostname says. Scheme is deliberately *not* part of the
 * comparison, so an `http://` link on an `https://` page still reads as the
 * same site rather than as somewhere new.
 */
export function classifyLink(href: string, documentUrl: string): LinkKind {
  const target = href.trim();

  // Both address the document already on screen. `#` is checked before parsing
  // because resolving it yields the base URL, which would look same-host.
  if (target === '' || target.startsWith('#')) return 'fragment';

  // URL parsing strips tabs and newlines, so `java\nscript:` lands in the
  // `javascript:` case rather than sliding through as an unknown scheme.
  const url = resolve(target, documentUrl);
  if (!url) return 'unknown';

  switch (url.protocol) {
    case 'mailto:':
      return 'mail';
    case 'tel:':
    case 'sms:':
    case 'callto:':
      return 'tel';
    case 'javascript:':
    case 'vbscript:':
    case 'data:':
    case 'blob:':
      return 'unsafe';
    case 'http:':
    case 'https:':
      break;
    default:
      // A `file://` link from a `file://` document is the local equivalent of a
      // relative path. From anywhere else it is a scheme we cannot reason about.
      return resolve(documentUrl)?.protocol === url.protocol
        ? 'internal'
        : 'unknown';
  }

  const base = resolve(documentUrl);
  // A document opened from disk has no host, so every http(s) link leaves it.
  if (!base || (base.protocol !== 'http:' && base.protocol !== 'https:')) {
    return 'external';
  }

  return url.host === base.host ? 'internal' : 'external';
}

/** The one question the document body actually asks. */
export function isExternalLink(href: string, documentUrl: string): boolean {
  return classifyLink(href, documentUrl) === 'external';
}

/* -------------------------------------------------------------------------- */
/* Marking the document                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Contexts an indicator is never added in.
 *
 * Headings already carry the anchor affordance in their gutter and set their
 * text at display sizes, where a trailing arrow reads as a typo. A table cell
 * is a link list by construction — a column of links is the whole point of the
 * column — so it falls under the same reasoning as the density limit.
 */
const SUPPRESSED_IN = 'h1, h2, h3, h4, h5, h6, th, td';

/**
 * The box a link's neighbours are counted in.
 *
 * Lists group by the list, not by the item: twenty `<li>`s holding one link
 * each are one link list, and counting per item would mark every one of them.
 */
const DENSITY_BLOCK = 'p, ul, ol, dl, blockquote, figcaption';

/** Whether the link's whole visible content is imagery — a badge or a logo. */
function isImageOnly(link: Element): boolean {
  if (link.textContent?.trim()) return false;
  return link.querySelector('img, svg, picture') !== null;
}

/**
 * Marks every link that leaves the document, once per pass.
 *
 * One query and one grouping pass; the work after that is proportional to the
 * number of links rather than to the number of nodes. Idempotent, so re-running
 * it after the body is replaced costs a re-mark and nothing else.
 */
export function markExternalLinks(
  root: ParentNode,
  documentUrl: string,
  limit: number = EXTERNAL_LINK_DENSITY_LIMIT,
): void {
  const blocks = new Map<Element | ParentNode, Element[]>();

  root.querySelectorAll('a[href]').forEach((link) => {
    if (link.closest(SUPPRESSED_IN)) return;
    if (isImageOnly(link)) return;
    if (!isExternalLink(link.getAttribute('href') ?? '', documentUrl)) return;

    const block = link.closest(DENSITY_BLOCK) ?? link.parentElement ?? root;
    const group = blocks.get(block);
    if (group) group.push(link);
    else blocks.set(block, [link]);
  });

  blocks.forEach((group) => {
    // Over the limit the whole group is left alone rather than truncated at an
    // arbitrary sixth link, which would look like a rendering bug.
    if (group.length > limit) return;
    group.forEach((link) => link.setAttribute(EXTERNAL_LINK_ATTRIBUTE, ''));
  });
}

/** Undoes `markExternalLinks` completely — turning the setting off leaves no residue. */
export function clearExternalLinks(root: ParentNode): void {
  root
    .querySelectorAll(`[${EXTERNAL_LINK_ATTRIBUTE}]`)
    .forEach((link) => link.removeAttribute(EXTERNAL_LINK_ATTRIBUTE));
}
