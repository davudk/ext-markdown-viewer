/**
 * Export.
 *
 * Injected on demand by the service worker (`ADDONS` in lib/config.ts) the first
 * time a reader picks a format, because `docx` is roughly 400 kB and most
 * documents are read, not exported. That is the whole reason this file exists:
 * `lib/export.ts` reaches `docx`, so anything in the React tree that imported it
 * would put the OOXML writer into every rendered page. Nothing does — the menu
 * asks for this add-on and calls what it publishes.
 *
 * The hand-off is a function on the isolated world's `window`, under
 * `EXPORT_BRIDGE_KEY` (config.ts explains the choice). An add-on script and a
 * React component are separate scripts but not separate realms: Chrome runs
 * every content script this extension injects into a frame in one isolated
 * world, so a live `Element` and a progress callback cross as themselves and the
 * answer comes back as an ordinary promise. The alternatives were considered and
 * rejected for the same reason: a `CustomEvent` pair or a promise registry keyed
 * by id would both add correlation bookkeeping *and* a way for a request to sit
 * there unanswered, and "the export hangs" is a worse failure than "the export
 * says it could not start". A missing property is checked for in one `typeof`.
 *
 * The world is the extension's own, not the page's, so the page cannot see this
 * property, call it, or replace it.
 *
 * A second injection re-runs the whole file with a fresh module scope, so the
 * install below is guarded on the property it is about to write.
 */

import { Packer } from 'docx';

import { EXPORT_BRIDGE_KEY, VIEWER_ROOT_ID } from '@/lib/config';
import {
  buildDocxDocument,
  buildHtmlDocument,
  cleanForExport,
  documentTitle,
  exportFilename,
  planDocument,
  snapshotImages,
  type ExportOptions,
  type ExportResult,
} from '@/lib/export';

/** What `components/ExportMenu.tsx` finds once this has run. */
export type ExportBridge = (options: ExportOptions) => Promise<ExportResult>;

interface BridgeHost {
  [EXPORT_BRIDGE_KEY]?: ExportBridge;
}

export default defineUnlistedScript(() => {
  // No viewer means nothing asked for this. The renderer is the only caller.
  if (!document.getElementById(VIEWER_ROOT_ID)) return;

  const host = globalThis as BridgeHost;
  // Idempotent, and it has to be recorded here rather than on the DOM: what a
  // second injection would duplicate is this function, not an element.
  if (typeof host[EXPORT_BRIDGE_KEY] === 'function') return;

  host[EXPORT_BRIDGE_KEY] = exportDocument;
});

/* -------------------------------------------------------------------------- */
/* Saving                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Long enough for the browser to have started reading the blob, short enough
 * that a session of exports does not pin every one of them in memory.
 */
const REVOKE_DELAY_MS = 60_000;

interface DownloadsApi {
  download: (
    options: { url: string; filename: string; saveAs?: boolean },
    callback?: (id?: number) => void,
  ) => void;
}

interface ChromeLike {
  downloads?: Partial<DownloadsApi>;
  runtime?: { lastError?: unknown };
}

/**
 * `chrome` is absent in a plain page and present-but-incomplete in a content
 * script, which is where this actually runs: `chrome.downloads` is an
 * extension-page API and a content script only ever sees `runtime` and
 * `storage`. So the guard is not defensive noise — the fallback is the path
 * that normally fires.
 */
function chromeApi(): ChromeLike | undefined {
  return (globalThis as { chrome?: ChromeLike }).chrome;
}

function downloadViaChrome(url: string, filename: string): Promise<boolean> {
  const api = chromeApi();
  const downloads = api?.downloads;
  if (typeof downloads?.download !== 'function') return Promise.resolve(false);

  return new Promise((resolve) => {
    try {
      (downloads as DownloadsApi).download({ url, filename, saveAs: false }, (id) => {
        // Read inside the callback, or Chrome logs it as an unchecked error.
        resolve(api?.runtime?.lastError === undefined && id !== undefined);
      });
    } catch {
      resolve(false);
    }
  });
}

function downloadViaAnchor(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';

  document.body.append(link);
  link.click();
  link.remove();
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);

  try {
    if (!(await downloadViaChrome(url, filename))) downloadViaAnchor(url, filename);
  } finally {
    // Deferred rather than immediate: both paths hand the URL to the browser and
    // return before the download has necessarily opened it. Skipping the revoke
    // is not an option — the blob is the whole document, held for as long as the
    // URL lives.
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function exportDocument(options: ExportOptions): Promise<ExportResult> {
  const { body, format, onProgress } = options;
  const url = options.url ?? (typeof location === 'undefined' ? '' : location.href);

  const images = Array.from(body.querySelectorAll('img'));
  const snapshots = await snapshotImages(images, onProgress);
  const unembedded = snapshots.filter((snapshot) => snapshot === null).length;

  onProgress?.({ stage: 'building', done: 0, total: images.length });

  const clone = cleanForExport(body, { baseUrl: url, images: snapshots });
  const title = options.title?.trim() || documentTitle(clone, url);
  const filename = exportFilename(title, format);

  let blob: Blob;
  let unwritable = 0;

  if (format === 'docx') {
    const built = buildDocxDocument(planDocument(clone), { title });
    blob = await Packer.toBlob(built.document);
    // Disjoint from `unembedded`: these serialized fine but are in a format the
    // package cannot carry, and were written out as their alt text instead.
    unwritable = built.skippedImages;
  } else {
    const html = buildHtmlDocument({
      title,
      bodyHtml: clone.innerHTML,
      theme: options.theme,
      typography: options.typography,
    });
    blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  }

  onProgress?.({ stage: 'saving', done: images.length, total: images.length });
  await saveBlob(blob, filename);

  return {
    format,
    filename,
    totalImages: images.length,
    skippedImages: unembedded + unwritable,
  };
}
