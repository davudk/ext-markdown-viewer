/**
 * Permission state, shared by the popup, the options page, and the service
 * worker.
 *
 * Nothing here is cached and nothing is mirrored into storage. Chrome's own
 * permission state is the single source of truth, for the same reason the
 * service worker rebuilds its registrations from `permissions.getAll()`: a
 * stored copy can disagree with reality — the user can revoke access from
 * chrome://extensions at any time — and a settings toggle that claims access
 * the browser has taken away is worse than no toggle at all.
 */

import { ALL_SITES, MARKDOWN_EXTENSIONS } from './config.ts';

export { ALL_SITES } from './config.ts';

/** Splits a granted origin into scheme and host; both may be wildcards. */
const ORIGIN_PATTERN = /^(\*|https?):\/\/([^/]+)\//;

/**
 * Turn one granted origin into per-extension match patterns.
 *
 * Registering the origin itself would run a ~400kB bundle on every page of that
 * site just to discover it isn't markdown, so the path glob does the filtering
 * up front. Scheme and host are copied verbatim, so an all-sites or
 * wildcard-subdomain grant stays exactly as wide as the user made it — this is
 * what makes the "render automatically on every site" setting work.
 */
export function expandOrigin(origin: string): string[] {
  const match = ORIGIN_PATTERN.exec(origin);
  if (!match) return [];

  const [, scheme, host] = match;
  return MARKDOWN_EXTENSIONS.map((ext) => `${scheme}://${host}/*${ext}`);
}

/** Match patterns for local files, used only when file access is enabled. */
export function fileMatchPatterns(): string[] {
  return MARKDOWN_EXTENSIONS.map((ext) => `file:///*${ext}`);
}

/**
 * Whether automatic rendering is on. Derived, never stored: the answer is
 * exactly "does the extension hold the all-sites permission right now".
 */
export async function isAutoRenderEnabled(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [ALL_SITES] });
  } catch {
    return false;
  }
}

/**
 * Must be called directly from a click handler — `permissions.request()` needs
 * a user gesture and will reject if anything is awaited before it. Resolves
 * false when the user declines, which is a normal outcome, not an error.
 */
export function requestAutoRender(): Promise<boolean> {
  return chrome.permissions.request({ origins: [ALL_SITES] });
}

export function disableAutoRender(): Promise<boolean> {
  return chrome.permissions.remove({ origins: [ALL_SITES] });
}

/**
 * Individually granted sites, excluding the all-sites grant — that one is
 * presented as the automatic-rendering switch rather than as a list entry.
 */
export async function listGrantedOrigins(): Promise<string[]> {
  try {
    const { origins = [] } = await chrome.permissions.getAll();
    return origins
      .filter((origin) => origin !== ALL_SITES && /^(\*|https?):\/\//.test(origin))
      .sort();
  } catch {
    return [];
  }
}

export function revokeOrigin(origin: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: [origin] });
}

/** Turns `https://example.com/*` back into something worth showing a person. */
export function originLabel(origin: string): string {
  return origin.replace(/^(\*|https?):\/\//, '').replace(/\/\*$/, '');
}

/**
 * file:// access is a browser-level toggle, not an optional permission — it
 * cannot be requested at runtime, only detected. Optional across browsers and
 * versions, so the call itself has to be guarded.
 */
export async function hasFileAccess(): Promise<boolean> {
  try {
    return (await chrome.extension?.isAllowedFileSchemeAccess?.()) ?? false;
  } catch {
    return false;
  }
}
