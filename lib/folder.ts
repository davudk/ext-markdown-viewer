/**
 * The File System Access plumbing behind the Files tab.
 *
 * Everything here is I/O and naming: picking a directory, remembering it,
 * re-asking for permission, reading one level of it at a time, and working out
 * what a file inside it should be *called* once it is on screen. The component
 * owns the tree and the keyboard; this file owns the browser API.
 *
 * Three facts shape the whole design, and all three were measured rather than
 * assumed (headless Chrome 141, macOS):
 *
 *   · `file://` is a secure context, `showDirectoryPicker` is exposed there in
 *     both the main world and an isolated world, and with a user gesture the
 *     call gets all the way to the picker. Local files are the main use case for
 *     a folder browser, so this was the question worth answering first.
 *
 *   · IndexedDB is available on `file://`, and every `file://` document shares
 *     the single origin `file://`. A folder connected while reading one local
 *     note is therefore offered again while reading any other — which is the
 *     behaviour a reader would expect and, on http(s), the behaviour they do
 *     *not* get, because a content script stores under the page's own origin.
 *
 *   · A handle never reveals a path. `name` is a basename and `resolve()` is
 *     relative, so there is no way to turn a handle into a `file://` URL — the
 *     one place a real URL can be recovered is by matching the folder against
 *     the address of the document already on screen. See `resolveFileUrlBase`.
 *
 * Nothing here fetches. Reading a `FileSystemFileHandle` is a disk read.
 */

import { FOLDER_DOCUMENT_SCHEME, MARKDOWN_EXTENSIONS } from './config.ts';

/* -------------------------------------------------------------------------- */
/* Limits and storage                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Directories never listed, whatever they contain. Dotted names are excluded by
 * rule rather than by list; these two are the ones that are not dotted and are
 * large enough that expanding one is indistinguishable from a hang.
 */
export const FOLDER_SKIP_DIRECTORIES = ['node_modules', '.git'];

/**
 * Entries kept from a single directory. A generated output folder can hold tens
 * of thousands of files, and the cost is not the read — it is the rows. The
 * browser reports the overflow rather than pretending the directory ends here.
 */
export const FOLDER_ENTRY_LIMIT = 500;

/**
 * Where a picked directory handle is kept.
 *
 * IndexedDB, because a `FileSystemDirectoryHandle` is structured-cloneable but
 * not JSON — chrome.storage cannot hold one. What this does and does not
 * survive is below; the short version is that a content script writes under the
 * *page's* origin, so this is per-origin storage, not per-extension.
 */
export const FOLDER_DB_NAME = 'mdv-folder';
export const FOLDER_STORE_NAME = 'handles';
export const FOLDER_HANDLE_KEY = 'current';

/* -------------------------------------------------------------------------- */
/* Types TypeScript's lib.dom does not ship                                    */
/* -------------------------------------------------------------------------- */

/**
 * `showDirectoryPicker` and the two permission methods are Chromium-only and
 * absent from lib.dom.d.ts, so they are declared here rather than pulled in as
 * a dependency. Narrowed to the three calls this file actually makes.
 */
export type FolderPermission = 'granted' | 'denied' | 'prompt';

interface HandlePermissions {
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FolderPermission>;
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FolderPermission>;
}

interface PickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

/** A file the viewer can render, by extension. Case-insensitive; `.MD` is a .md. */
export function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Entries never listed at all.
 *
 * Dotted names go first because the rule is general: `.git` is only the most
 * obvious of them, and a reader looking for their notes has no use for
 * `.DS_Store`, `.venv` or `.obsidian` either.
 */
export function isSkippedName(name: string): boolean {
  if (name.startsWith('.')) return true;
  return FOLDER_SKIP_DIRECTORIES.includes(name);
}

/** Directories first, then files; each group in the reader's own collation. */
export function sortEntries<T extends { name: string; kind: 'file' | 'directory' }>(
  entries: T[],
): T[] {
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

/** Slash-joined, with no leading slash. The root itself is the empty path. */
export function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

/**
 * Text as the renderer would have seen it had Chrome painted the file itself.
 *
 * The HTML parser normalizes CRLF to LF while building the `<pre>` the viewer
 * reads its source out of, and eats a leading BOM. A handle read does neither,
 * so the two only compare equal after this. Used by `resolveFileUrlBase`, where
 * a spurious mismatch silently costs real URLs.
 */
export function normalizeSource(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/* -------------------------------------------------------------------------- */
/* Document identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What to call a document that was read through a handle.
 *
 * It has no address — that is the whole difficulty — so it gets a stable
 * synthetic one instead of borrowing the address of the document it replaced.
 * Borrowing would be the silent failure: scroll memory would file two different
 * files under one key, and live reload would poll the *old* file and overwrite
 * the new one with it. Under its own scheme, `documentKey` keeps them apart and
 * `liveReloadTarget` declines it, both without a special case.
 */
export function folderDocumentUrl(rootName: string, path: string): string {
  const segments = [rootName, ...path.split('/')].filter((part) => part.length > 0);
  return FOLDER_DOCUMENT_SCHEME + segments.map(encodeURIComponent).join('/');
}

/** The path inside `rootName` that such an identity refers to, or null. */
export function folderDocumentPath(url: string, rootName: string): string | null {
  if (!url.startsWith(FOLDER_DOCUMENT_SCHEME)) return null;

  const segments = url
    .slice(FOLDER_DOCUMENT_SCHEME.length)
    .split(/[?#]/)[0]
    .split('/')
    .map(decodeSegment);

  if (segments.length < 2 || segments[0] !== rootName) return null;
  return segments.slice(1).join('/');
}

/* -------------------------------------------------------------------------- */
/* Recovering real file:// URLs                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where the picked directory *might* sit, given the address of the document on
 * screen — deepest candidate first.
 *
 * A handle carries a basename and nothing else, so the only lead is that the
 * document being read is usually inside the folder the reader just picked. If
 * the page is `file:///Users/me/notes/sub/a.md` and the folder is called
 * `notes`, then the folder is *probably* `file:///Users/me/notes/`. Probably is
 * not good enough to act on, which is why `resolveFileUrlBase` checks the guess
 * against the bytes before anything uses it.
 *
 * Deepest first because a repeated segment (`.../notes/vendor/notes/a.md`) is
 * far more likely to be the near one, and each candidate costs a file read.
 */
export function fileUrlBaseCandidates(pageUrl: string, directoryName: string): string[] {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return [];
  }

  if (url.protocol !== 'file:') return [];

  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  const bases: string[] = [];

  // The last segment is the file itself, so it can never be the directory.
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (decodeSegment(segments[index]) !== directoryName) continue;
    bases.push(`${url.protocol}//${url.host}/${segments.slice(0, index + 1).join('/')}/`);
  }

  return bases;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The path of `pageUrl` relative to `base`, or null when it is not under it. */
export function relativePathFrom(base: string, pageUrl: string): string | null {
  if (!pageUrl.startsWith(base)) return null;

  const rest = pageUrl.slice(base.length).split(/[?#]/)[0];
  if (rest.length === 0) return null;

  return rest.split('/').map(decodeSegment).join('/');
}

/** A real address for a file inside a confirmed base. Segments re-encoded. */
export function fileUrlFor(base: string, path: string): string {
  return base + path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The picked folder's real `file://` address, or null if it cannot be proved.
 *
 * Proved is the operative word. The candidate base is turned back into a path
 * relative to the root, that path is walked down through the handle, and the
 * file it lands on is read and compared with what is on screen. Only an exact
 * match confirms the guess — a same-named folder somewhere else on disk fails
 * the comparison and is discarded rather than becoming a link to the wrong file.
 *
 * Costs at most one directory walk and one file read per candidate, and no
 * enumeration at all: every step is `getDirectoryHandle` by name.
 */
export async function resolveFileUrlBase(
  root: FileSystemDirectoryHandle,
  pageUrl: string,
  pageSource: string,
): Promise<string | null> {
  const wanted = normalizeSource(pageSource);

  for (const base of fileUrlBaseCandidates(pageUrl, root.name)) {
    const relative = relativePathFrom(base, pageUrl.split(/[?#]/)[0]);
    if (relative === null) continue;

    try {
      const segments = relative.split('/');
      let directory = root;
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment);
      }

      const file = await directory.getFileHandle(segments[segments.length - 1]);
      const text = normalizeSource(await (await file.getFile()).text());
      if (text === wanted) return base;
    } catch {
      // No such entry, or no permission to read it. Either way this candidate
      // is not the folder; try the next one.
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

export interface FolderEntry {
  name: string;
  /** Path relative to the root, so it is stable across expand and collapse. */
  path: string;
  kind: 'file' | 'directory';
  handle: FileSystemDirectoryHandle | FileSystemFileHandle;
}

export interface DirectoryListing {
  entries: FolderEntry[];
  /** True when the directory held more than FOLDER_ENTRY_LIMIT usable entries. */
  truncated: boolean;
}

/**
 * One level of a directory: its subdirectories and its markdown files.
 *
 * Lazy on purpose. Walking a tree up front is what makes a folder browser hang
 * on a repository, and it is wasted work — a reader opens two or three
 * directories, not four thousand. The async iterator is also what keeps a huge
 * directory from blocking: it yields between entries, so the tab stays alive
 * while it reads, and the count is capped before the rows are ever built.
 *
 * Directories are listed without being opened, so one holding no markdown at
 * all still appears. The alternative is a recursive walk per directory on every
 * expand, which is the cost this whole approach exists to avoid.
 */
export async function readDirectory(
  handle: FileSystemDirectoryHandle,
  path = '',
): Promise<DirectoryListing> {
  const entries: FolderEntry[] = [];
  let truncated = false;

  for await (const child of handle.values()) {
    if (isSkippedName(child.name)) continue;
    if (child.kind === 'file' && !isMarkdownName(child.name)) continue;

    if (entries.length >= FOLDER_ENTRY_LIMIT) {
      truncated = true;
      break;
    }

    entries.push({
      name: child.name,
      path: joinPath(path, child.name),
      kind: child.kind,
      handle: child as FileSystemDirectoryHandle | FileSystemFileHandle,
    });
  }

  return { entries: sortEntries(entries), truncated };
}

export async function readFileText(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

/* -------------------------------------------------------------------------- */
/* Picking and permissions                                                     */
/* -------------------------------------------------------------------------- */

/** Whether this browser can open a folder at all. Sync, so the UI can say why. */
export function isFolderBrowserSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as PickerWindow).showDirectoryPicker === 'function' &&
    window.isSecureContext
  );
}

/**
 * Opens the picker. Null on cancel; that is a decision, not a failure.
 *
 * Must be called straight out of a click: the picker needs transient user
 * activation, and an `await` before it spends the activation the click granted.
 */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;

  try {
    // `id` asks Chrome to reopen where this picker was last used, so the second
    // folder a reader opens starts somewhere they recognise.
    return await picker({ id: 'mdv-folder', mode: 'read' });
  } catch {
    // AbortError for a cancelled dialog, SecurityError for a stale activation.
    return null;
  }
}

/** What we may do with a recalled handle *without* asking. Never prompts. */
export async function folderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<FolderPermission> {
  const query = (handle as HandlePermissions).queryPermission;
  if (!query) return 'granted';

  try {
    return await query.call(handle, { mode: 'read' });
  } catch {
    return 'prompt';
  }
}

/**
 * Asks for read access. Needs transient user activation exactly as the picker
 * does, so this only ever runs from a button — never from an effect on load.
 */
export async function requestFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<FolderPermission> {
  const request = (handle as HandlePermissions).requestPermission;
  if (!request) return 'granted';

  try {
    return await request.call(handle, { mode: 'read' });
  } catch {
    return 'denied';
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A directory handle survives a reload only because IndexedDB stores structured
 * clones; there is no serialisation of it we could put in chrome.storage.
 *
 * What that buys, honestly:
 *
 *   · `file://` — one shared origin for every local document, so the folder is
 *     remembered across files and across restarts. Chrome downgrades the grant
 *     to `prompt` on restart, so the tab shows a Reconnect button rather than
 *     pretending; one click restores it.
 *   · `http(s)://` — the content script writes under the *site's* origin, so a
 *     folder opened on one site is invisible on another. Nothing can be done
 *     about that from a content script, so the UI never implies otherwise.
 *
 * Every call is best-effort. A browser with IndexedDB disabled loses the
 * remembering, not the feature.
 */
async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;

  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(FOLDER_DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(FOLDER_STORE_NAME)) {
          request.result.createObjectStore(FOLDER_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('blocked'));
    });
  } catch {
    return null;
  }
}

export async function rememberFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FOLDER_STORE_NAME, 'readwrite');
      tx.objectStore(FOLDER_STORE_NAME).put(handle, FOLDER_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // The folder is open for this document either way; it just will not be
    // offered again on the next one.
  } finally {
    db.close();
  }
}

export async function recallFolder(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDatabase();
  if (!db) return null;

  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const request = db
        .transaction(FOLDER_STORE_NAME)
        .objectStore(FOLDER_STORE_NAME)
        .get(FOLDER_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // Storage outlives the code that wrote it, and a handle is the one thing
    // here that cannot be revalidated by shape alone.
    return isDirectoryHandle(stored) ? stored : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function forgetFolder(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FOLDER_STORE_NAME, 'readwrite');
      tx.objectStore(FOLDER_STORE_NAME).delete(FOLDER_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Nothing to do; the handle stays and is re-offered next time.
  } finally {
    db.close();
  }
}

function isDirectoryHandle(value: unknown): value is FileSystemDirectoryHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as FileSystemHandle).kind === 'directory' &&
    typeof (value as FileSystemDirectoryHandle).values === 'function'
  );
}
