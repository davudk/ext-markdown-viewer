/**
 * Activation rules — whether a given page is one we should render.
 *
 * These run in two places with different information available, so they're
 * split: the service worker only has a URL to go on, while the renderer can
 * additionally see the response's content type and the shape of the DOM.
 *
 * The lists these decisions are made from live in `config.ts`.
 */

import {
  MARKDOWN_CONTENT_TYPES,
  MARKDOWN_EXTENSIONS,
  RAW_HOSTS,
  RENDERS_ITS_OWN_MARKDOWN,
  RESTRICTED_SCHEMES,
  SUPPORTED_PROTOCOLS,
} from './config.ts';

/** Exact host or any subdomain of it. Never a substring — "notgithub.com" is not github. */
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

/** A browser-internal page, where no extension may run whatever the URL looks like. */
export function isRestrictedUrl(rawUrl: string): boolean {
  try {
    return RESTRICTED_SCHEMES.includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/**
 * Whether a URL is a plausible markdown target. Deliberately permissive: it
 * decides whether to *offer* rendering, and the renderer re-checks against the
 * real content type before touching anything.
 */
export function isCandidateUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!SUPPORTED_PROTOCOLS.includes(url.protocol)) return false;
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
