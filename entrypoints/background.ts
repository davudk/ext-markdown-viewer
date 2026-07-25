import { MARKDOWN_EXTENSIONS } from '@/lib/detect';
import {
  RENDERER_CSS,
  RENDERER_JS,
  type Message,
  type RenderTabResult,
  type SyncResult,
} from '@/lib/messages';

/**
 * A single stable id for everything we register. Registrations are always
 * rebuilt wholesale from granted permissions, so there is never more than one.
 */
const SCRIPT_ID = 'markdown-auto';

/** Splits a granted origin into scheme and host; both may be wildcards. */
const ORIGIN_PATTERN = /^(\*|https?):\/\/([^/]+)\//;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn one granted origin into per-extension match patterns.
 *
 * Registering the origin itself would run a ~400kB bundle on every page of
 * that site just to discover it isn't markdown, so the path glob does the
 * filtering up front. Scheme and host are copied verbatim, so an all-sites or
 * wildcard-subdomain grant stays exactly as wide as the user made it.
 */
function expandOrigin(origin: string): string[] {
  const match = ORIGIN_PATTERN.exec(origin);
  if (!match) return [];

  const [, scheme, host] = match;
  return MARKDOWN_EXTENSIONS.map((ext) => `${scheme}://${host}/*${ext}`);
}

/** Optional across browsers and versions, so the call itself has to be guarded. */
async function hasFileAccess(): Promise<boolean> {
  try {
    return (await chrome.extension?.isAllowedFileSchemeAccess?.()) ?? false;
  } catch {
    return false;
  }
}

async function unregisterExisting(): Promise<void> {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ids = existing
      .map((script) => script.id)
      .filter((id) => id === SCRIPT_ID);
    if (ids.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids });
    }
  } catch {
    // Nothing to remove is the expected state on a fresh worker, not a failure.
  }
}

/**
 * Rebuild the registration from `permissions.getAll()` rather than tracking
 * what we registered before. Granted permissions are the only thing the user
 * can change, and deriving from them means the two can't drift — a revoked
 * origin disappears from the next sync with no bookkeeping to get wrong. It
 * also survives the service worker being killed mid-change.
 */
async function syncRegistrations(): Promise<number> {
  const granted = await chrome.permissions.getAll();
  const matches = new Set(
    (granted.origins ?? []).flatMap(expandOrigin),
  );

  // file:// is not an optional permission; it's a browser-level toggle.
  if (await hasFileAccess()) {
    for (const ext of MARKDOWN_EXTENSIONS) matches.add(`file:///*${ext}`);
  }

  await unregisterExisting();
  if (matches.size === 0) return 0;

  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      matches: [...matches],
      js: [RENDERER_JS],
      css: [RENDERER_CSS],
      runAt: 'document_start',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);

  return matches.size;
}

/** Injects the renderer using the activeTab grant, which needs no host permission. */
async function renderTab(tabId: number): Promise<RenderTabResult> {
  try {
    // CSS first so the document never flashes unstyled between the two calls.
    await chrome.scripting.insertCSS({ target: { tabId }, files: [RENDERER_CSS] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [RENDERER_JS] });
    return { ok: true };
  } catch (error) {
    // Usually activeTab wasn't granted for this tab, or it's a restricted page.
    return { ok: false, error: errorMessage(error) };
  }
}

/** Lifecycle-triggered sync: no caller is listening, so failures only get logged. */
function resync(): void {
  void syncRegistrations().catch((error) => {
    console.error('[markdown-viewer] registration sync failed:', error);
  });
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse) => {
      switch (message.type) {
        case 'RENDER_TAB':
          renderTab(message.tabId).then(sendResponse);
          return true;

        case 'SYNC_REGISTRATIONS':
          syncRegistrations()
            .then((patterns) =>
              sendResponse({ ok: true, patterns } satisfies SyncResult),
            )
            .catch((error) =>
              sendResponse({
                ok: false,
                patterns: 0,
                error: errorMessage(error),
              } satisfies SyncResult),
            );
          return true;

        default:
          return false;
      }
    },
  );

  // Every path that can change granted permissions re-derives the registration.
  // onRemoved is the important one: without it, revoking a site's access would
  // leave its content script registered and still injecting.
  chrome.runtime.onInstalled.addListener(resync);
  chrome.runtime.onStartup.addListener(resync);
  chrome.permissions.onAdded.addListener(resync);
  chrome.permissions.onRemoved.addListener(resync);
});
