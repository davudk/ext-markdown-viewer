/**
 * Activation rules. These run in two places with different information
 * available, so they're split: the service worker only has a URL to go on,
 * while the content script can additionally see the response's content type
 * and the shape of the DOM.
 */

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mkd', '.mdx'];

const MARKDOWN_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
];

/**
 * Hosts that render markdown themselves. Most serve text/html and would be
 * filtered by the content-type check anyway, but they're listed explicitly so
 * a redesign on their end can't turn us into a page-wrecking bug.
 */
const RENDERS_ITS_OWN_MARKDOWN = [
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
const RAW_HOSTS = [
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'raw.githack.com',
  'cdn.jsdelivr.net',
];

function hostMatches(hostname: string, list: string[]): boolean {
  const host = hostname.toLowerCase();
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function hasMarkdownExtension(pathname: string): boolean {
  // Strip a trailing slash so ".../README.md/" still counts.
  const path = pathname.toLowerCase().replace(/\/+$/, '');
  return MARKDOWN_EXTENSIONS.some((ext) => path.endsWith(ext));
}

export function isMarkdownContentType(contentType: string): boolean {
  // `document.contentType` is already bare, but be tolerant of a raw header.
  const type = contentType.toLowerCase().split(';')[0].trim();
  return MARKDOWN_CONTENT_TYPES.includes(type);
}

/**
 * Whether a URL is a plausible markdown target. Deliberately permissive: it
 * decides whether to *offer* rendering, and the content script re-checks
 * against the real content type before touching anything.
 */
export function isCandidateUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!['http:', 'https:', 'file:'].includes(url.protocol)) return false;
  if (!hasMarkdownExtension(url.pathname)) return false;

  // A raw host serves the file verbatim even when its parent domain renders
  // markdown itself, so this check has to come first.
  if (hostMatches(url.hostname, RAW_HOSTS)) return true;
  if (hostMatches(url.hostname, RENDERS_ITS_OWN_MARKDOWN)) return false;

  return true;
}

/** The `https://example.com/*` form that `permissions.request()` expects. */
export function originPattern(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}
