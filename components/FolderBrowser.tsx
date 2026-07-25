import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';

import {
  createMatcher,
  publishFolder,
  type FuzzyField,
  type PaletteFile,
} from '@/lib/commands';
import { CONTEXT_MENU_KEYS, FILTER_RESULT_LIMIT } from '@/lib/config';
import type { CompareRequest } from '@/lib/diff';
import {
  fileUrlFor,
  folderDocumentPath,
  folderDocumentUrl,
  folderPermission,
  isFolderBrowserSupported,
  pickFolder,
  readDirectory,
  readFileText,
  recallFolder,
  relativePathFrom,
  rememberFolder,
  requestFolderPermission,
  resolveFileUrlBase,
  forgetFolder,
  type DirectoryListing,
  type FolderEntry,
} from '@/lib/folder';

import { FilterBox, useFuzzy } from './CommandPalette';

import './folder-browser.css';

/**
 * What the filter box matches on.
 *
 * The path is weighted low but present: typing `guides` should surface the files
 * under `docs/guides/`, and never above a file actually named that.
 */
const FILTER_FIELDS: readonly FuzzyField[] = [
  { name: 'name', weight: 1 },
  { name: 'path', weight: 0.4 },
];

/** What the tab strip is told, so it can say why the tab is empty. */
export type FolderStatus = 'unsupported' | 'idle' | 'ready';

/**
 * A file the reader opened through a handle rather than by address.
 *
 * `url` is the synthetic `mdv-folder:` identity from `lib/folder.ts` — it is
 * what scroll memory keys on and what live reload declines, and it is never a
 * place anything tries to go.
 */
export interface OpenedDocument {
  url: string;
  /** Basename, for a title. */
  name: string;
  /** Path relative to the folder root. */
  path: string;
  source: string;
}

/** A row in the flattened tree. Depth is carried, not implied by nesting. */
interface Row {
  entry: FolderEntry;
  depth: number;
  expanded: boolean;
  /** Position among its siblings, for `aria-posinset`/`aria-setsize`. */
  position: number;
  size: number;
}

/**
 * The Files tab: a lazily-read tree of a folder the reader picked, filtered to
 * markdown.
 *
 * Two things here are worth knowing before reading the code.
 *
 * **Opening a file.** The viewer renders whatever is at `location.href`, and a
 * `FileSystemFileHandle` has no address at all — `name` is a basename and
 * `resolve()` is relative to the root, by design. So there are two paths, and
 * the good one is taken whenever it can be *proved* available:
 *
 *   1. On a `file://` page, `resolveFileUrlBase` works out the folder's real
 *      address by matching it against the address of the document already on
 *      screen and confirming the guess byte-for-byte. When that succeeds every
 *      row becomes an ordinary `<a href="file://…">`: a real navigation, so the
 *      address bar, scroll memory, live reload and relative image links are all
 *      simply correct, and middle-click and copy-link work for free. It needs
 *      no extra permission — the extension is already rendering a local file,
 *      which means it already has file access.
 *
 *   2. Otherwise the file is read through the handle and handed to the shell,
 *      which swaps the rendered source. The address bar then *does* still show
 *      the old document, and rather than paper over that the file gets its own
 *      `mdv-folder:` identity: scroll memory files it separately, live reload
 *      declines it instead of polling the previous URL, and the tree keeps the
 *      open file marked so the sidebar is the honest answer to "what is this".
 *
 * **Reading.** One directory per expand, never a walk. `lib/folder.ts` caps the
 * entries it keeps and reports the overflow; the async iterator yields between
 * entries, so even a directory that hits the cap does not block the tab.
 */
export function FolderBrowser({
  documentUrl,
  source,
  visible,
  onOpen,
  onCompare,
  onStatusChange,
}: {
  /** The document on screen — `location.href` or an `mdv-folder:` identity. */
  documentUrl: string;
  /**
   * The markdown on screen. Read once, on connect, to confirm which folder on
   * disk the handle refers to; see `resolveFileUrlBase`.
   */
  source: string;
  /** Whether this panel is the one showing. Focus is only moved when it is. */
  visible: boolean;
  onOpen: (document: OpenedDocument) => void;
  /**
   * A file row asked for its menu, by right-click or from the keyboard.
   *
   * Reporting the request rather than acting on it: this component knows which
   * file was pointed at and how to read it, and nothing else. Whoever owns the
   * menu decides what may be done with it. Omitting the prop leaves the
   * browser's own context menu untouched.
   */
  onCompare?: (request: CompareRequest) => void;
  onStatusChange: (status: FolderStatus) => void;
}) {
  const supported = useMemo(isFolderBrowserSupported, []);

  const [root, setRoot] = useState<FileSystemDirectoryHandle | null>(null);
  /** Recalled from storage but not yet permitted; needs a click to reconnect. */
  const [pending, setPending] = useState<FileSystemDirectoryHandle | null>(null);
  const [listings, setListings] = useState<Map<string, DirectoryListing>>(new Map());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** The folder's real `file://` address once proved, enabling real navigation. */
  const [base, setBase] = useState<string | null>(null);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const fuse = useFuzzy();
  const treeId = useId();

  // The source as the page loaded with it. Opening a file through a handle
  // replaces `source`, so the value the folder is verified against has to be
  // pinned before that can happen.
  const originalSource = useRef(source);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onStatusChange(!supported ? 'unsupported' : root ? 'ready' : 'idle');
  }, [supported, root, onStatusChange]);

  /* --- connecting --------------------------------------------------------- */

  const connect = useCallback(async (handle: FileSystemDirectoryHandle) => {
    setError(null);
    setRoot(handle);
    setOpened(new Set());
    setFocusPath(null);
    void rememberFolder(handle);

    try {
      const listing = await readDirectory(handle);
      setListings(new Map([['', listing]]));
    } catch {
      setError('That folder could not be read.');
      setListings(new Map());
    }

    // Best effort and never fatal: without it every row is a button that swaps
    // the source in place, which still works — it just cannot use the address
    // bar. Failure here must not cost the reader the folder.
    try {
      setBase(await resolveFileUrlBase(handle, location.href, originalSource.current));
    } catch {
      setBase(null);
    }
  }, []);

  // A handle stored on a previous visit. Chrome downgrades the grant to
  // `prompt` across a restart, and re-asking needs user activation — so a
  // recalled handle that is not already granted becomes a button, never an
  // automatic prompt the reader did not ask for.
  useEffect(() => {
    if (!supported) return;

    let alive = true;
    void (async () => {
      const handle = await recallFolder();
      if (!alive || !handle) return;

      if ((await folderPermission(handle)) === 'granted') {
        if (alive) void connect(handle);
      } else if (alive) {
        setPending(handle);
      }
    })();

    return () => {
      alive = false;
    };
  }, [supported, connect]);

  const choose = useCallback(async () => {
    const handle = await pickFolder();
    if (!handle) return;
    setPending(null);
    await connect(handle);
  }, [connect]);

  const reconnect = useCallback(async () => {
    if (!pending) return;

    if ((await requestFolderPermission(pending)) !== 'granted') {
      setError(`Access to ${pending.name} was declined.`);
      return;
    }

    setPending(null);
    await connect(pending);
  }, [pending, connect]);

  const close = useCallback(() => {
    setRoot(null);
    setPending(null);
    setListings(new Map());
    setOpened(new Set());
    setBase(null);
    setError(null);
    void forgetFolder();
  }, []);

  /* --- the tree ----------------------------------------------------------- */

  const toggle = useCallback(
    async (entry: FolderEntry) => {
      const isOpen = opened.has(entry.path);

      setOpened((current) => {
        const next = new Set(current);
        if (isOpen) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });

      if (isOpen || listings.has(entry.path)) return;

      setLoading((current) => new Set(current).add(entry.path));
      try {
        const listing = await readDirectory(
          entry.handle as FileSystemDirectoryHandle,
          entry.path,
        );
        setListings((current) => new Map(current).set(entry.path, listing));
      } catch {
        // An unreadable subdirectory is a fact about that directory, not a
        // reason to tear down the tree — it simply expands to nothing.
        setListings((current) =>
          new Map(current).set(entry.path, { entries: [], truncated: false }),
        );
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(entry.path);
          return next;
        });
      }
    },
    [opened, listings],
  );

  const open = useCallback(
    async (entry: FolderEntry) => {
      if (!root) return;

      try {
        const text = await readFileText(entry.handle as FileSystemFileHandle);
        onOpen({
          url: folderDocumentUrl(root.name, entry.path),
          name: entry.name,
          path: entry.path,
          source: text,
        });
      } catch {
        setError(`${entry.name} could not be read.`);
      }
    },
    [root, onOpen],
  );

  /* --- filtering ---------------------------------------------------------- */

  /**
   * Every markdown file read so far, flat.
   *
   * "So far" is the honest word: directories are read one expand at a time and
   * that is deliberate, so the filter searches what has been opened rather than
   * walking the disk behind the reader's back. The note under the results says
   * so whenever anything is still unread — a filter that quietly searches half
   * a folder is worse than one that says which half.
   */
  const knownFiles = useMemo(() => {
    const files: { name: string; path: string; entry: FolderEntry }[] = [];
    for (const listing of listings.values()) {
      for (const entry of listing.entries) {
        if (entry.kind === 'file') files.push({ name: entry.name, path: entry.path, entry });
      }
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }, [listings]);

  /** True while any listed directory has not been expanded and read. */
  const partiallyRead = useMemo(
    () =>
      [...listings.values()].some((listing) =>
        listing.entries.some(
          (entry) => entry.kind === 'directory' && !listings.has(entry.path),
        ),
      ),
    [listings],
  );

  const filterMatch = useMemo(
    () => createMatcher(knownFiles, FILTER_FIELDS, fuse, FILTER_RESULT_LIMIT),
    [knownFiles, fuse],
  );

  /** Null while the box is empty, which is what selects the tree over the list. */
  const matched = useMemo(() => {
    const query = filter.trim();
    if (query.length === 0) return null;
    return filterMatch(query).map((result) => result.item);
  }, [filterMatch, filter]);

  /**
   * Every visible row, in the order they are painted. Drives keyboard movement.
   *
   * Filtered results are rows of the same shape at depth zero, so arrow keys,
   * the roving tabindex and `aria-posinset` all keep working across the switch
   * without a second keyboard model to maintain.
   */
  const rows = useMemo(
    () =>
      matched === null
        ? flatten(listings, opened)
        : matched.map((file, index) => ({
            entry: file.entry,
            depth: 0,
            expanded: false,
            position: index + 1,
            size: matched.length,
          })),
    [matched, listings, opened],
  );

  /** Which file is on screen, however it got there. */
  const currentPath = useMemo(() => {
    if (!root) return null;
    if (base) return relativePathFrom(base, documentUrl.split(/[?#]/)[0]);
    return folderDocumentPath(documentUrl, root.name);
  }, [root, base, documentUrl]);

  const focusRow = useCallback((path: string) => {
    setFocusPath(path);
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-mdv-path="${CSS.escape(path)}"]`)
      ?.focus();
  }, []);

  /* --- what the command palette is told ----------------------------------- */

  /** Opens a file by path, taking the real-navigation route when there is one. */
  const openPath = useCallback(
    (path: string) => {
      const file = knownFiles.find((candidate) => candidate.path === path);
      if (!file) return;

      // The same choice a row makes: a proved `file://` address is an ordinary
      // navigation, and everything else is read through the handle.
      if (base) location.assign(fileUrlFor(base, path));
      else void open(file.entry);
    },
    [knownFiles, base, open],
  );

  const paletteFiles = useMemo<PaletteFile[]>(
    () =>
      knownFiles.map((file) => ({
        id: file.path,
        name: file.name,
        detail: parentOf(file.path) || (root?.name ?? ''),
      })),
    [knownFiles, root],
  );

  // The palette is a sibling of the sidebar, not a descendant of it, so what
  // this component knows reaches it through the registry in lib/commands.ts
  // rather than through two components whose only job would be forwarding it.
  useEffect(() => {
    publishFolder({
      supported,
      rootName: root?.name ?? null,
      files: paletteFiles,
      choose: () => void choose(),
      open: openPath,
    });
  }, [supported, root, paletteFiles, choose, openPath]);

  // Separately, and only on unmount: the registration is a live handle on a
  // mounted component, and the palette must not be left holding one that is not.
  useEffect(() => () => publishFolder(null), []);

  /**
   * Raises the menu for whichever file row an event landed on.
   *
   * Returns false — and does nothing — for a directory row, for the empty space
   * around the tree, and when no owner is listening, which is what lets both
   * callers below decide whether to take the event away from the browser.
   */
  const requestMenu = useCallback(
    (target: EventTarget | null, anchor: { x: number; y: number } | null) => {
      if (!onCompare) return false;

      const element =
        target instanceof HTMLElement
          ? target.closest<HTMLElement>('[data-mdv-path]')
          : null;
      const row = rows.find((candidate) => candidate.entry.path === element?.dataset.mdvPath);
      if (!row || row.entry.kind !== 'file') return false;

      onCompare({
        name: row.entry.name,
        path: row.entry.path,
        // A thunk, not the text: opening a menu must not read a file off disk.
        read: () => readFileText(row.entry.handle as FileSystemFileHandle),
        anchor,
        origin: element,
      });
      return true;
    },
    [onCompare, rows],
  );

  /**
   * The browser's own context menu is only suppressed over our own file rows.
   *
   * This tree is rendered inside a page the extension does not own, and taking
   * away the right-click anywhere else — on the empty space below the rows, on
   * a directory, on a selection — would be indistinguishable from a broken page.
   */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (requestMenu(event.target, { x: event.clientX, y: event.clientY })) {
      event.preventDefault();
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return;

    // The keyboard route to the same menu. Shift-F10 and the ContextMenu key
    // are what the platform binds; `c` is the one that works on a Mac, which
    // has neither. See CONTEXT_MENU_KEYS.
    if (
      CONTEXT_MENU_KEYS.includes(event.key) &&
      (event.key !== 'F10' || event.shiftKey) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const element = event.target instanceof HTMLElement ? event.target : null;
      const box = element?.getBoundingClientRect();
      // Anchored to the row rather than to a pointer that was never used, so
      // the menu opens where the focus ring already is.
      if (requestMenu(element, box ? { x: box.left + 16, y: box.bottom } : null)) {
        event.preventDefault();
        return;
      }
    }

    // Where the keystroke actually landed, not where state last recorded it.
    // A keydown arriving in the same task as the focus that preceded it would
    // otherwise be measured from the previous row.
    const from =
      (event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-mdv-path]')?.dataset.mdvPath
        : undefined) ?? focusPath;

    const at = Math.max(
      0,
      rows.findIndex((row) => row.entry.path === from),
    );
    const row = rows[at];

    const step = (to: number) => {
      event.preventDefault();
      focusRow(rows[Math.min(rows.length - 1, Math.max(0, to))].entry.path);
    };

    switch (event.key) {
      case 'ArrowDown':
        step(at + 1);
        return;
      case 'ArrowUp':
        step(at - 1);
        return;
      case 'Home':
        step(0);
        return;
      case 'End':
        step(rows.length - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        // Closed directory opens; open one descends into its first child, which
        // is the next row by construction.
        if (row.entry.kind === 'directory' && !row.expanded) void toggle(row.entry);
        else if (row.expanded && at + 1 < rows.length) focusRow(rows[at + 1].entry.path);
        return;
      case 'ArrowLeft': {
        event.preventDefault();
        if (row.entry.kind === 'directory' && row.expanded) {
          void toggle(row.entry);
          return;
        }
        // Otherwise up to the parent, which is the nearest row above that is
        // one level shallower.
        for (let index = at - 1; index >= 0; index -= 1) {
          if (rows[index].depth < row.depth) {
            focusRow(rows[index].entry.path);
            return;
          }
        }
        return;
      }
      case ' ':
        // A link row is an <a>, which ignores Space. Every other row is a real
        // button and needs no help.
        if (event.target instanceof HTMLAnchorElement) {
          event.preventDefault();
          event.target.click();
        }
        return;
      default:
    }
  };

  // Entering the tree with Tab should land on something. Only while showing:
  // moving focus into a hidden panel would steal it from the document.
  useEffect(() => {
    if (!visible || focusPath !== null || rows.length === 0) return;
    setFocusPath(currentPath ?? rows[0].entry.path);
  }, [visible, focusPath, rows, currentPath]);

  /* --- render ------------------------------------------------------------- */

  if (!supported) {
    return (
      <p className="mdv-side-empty">
        This browser cannot open local folders. The File System Access API is not
        available here.
      </p>
    );
  }

  if (!root) {
    return (
      <div className="mdv-folder-empty">
        <p className="mdv-side-empty">
          {pending
            ? `Reconnect ${pending.name} to browse it again.`
            : 'Open a folder to browse the markdown files in it.'}
        </p>

        <button
          type="button"
          className="mdv-folder-action"
          onClick={() => void (pending ? reconnect() : choose())}
        >
          {pending ? `Reconnect ${pending.name}` : 'Open folder…'}
        </button>

        {pending ? (
          <button
            type="button"
            className="mdv-folder-quiet"
            onClick={() => void choose()}
          >
            Open a different folder…
          </button>
        ) : null}

        {error ? (
          <p className="mdv-folder-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const rootListing = listings.get('');

  return (
    <>
      <div className="mdv-folder-bar">
        <span className="mdv-folder-name" title={root.name}>
          {root.name}
        </span>
        <button
          type="button"
          className="mdv-folder-quiet"
          title="Open a different folder"
          onClick={() => void choose()}
        >
          Change
        </button>
        <button
          type="button"
          className="mdv-folder-quiet"
          title="Close this folder"
          onClick={close}
        >
          Close
        </button>
      </div>

      {error ? (
        <p className="mdv-folder-error" role="alert">
          {error}
        </p>
      ) : null}

      <FilterBox
        value={filter}
        onChange={setFilter}
        label="Filter files"
        placeholder="Filter files"
        count={matched?.length ?? null}
        controls={treeId}
      />

      <div
        id={treeId}
        className="mdv-side-scroll"
        ref={treeRef}
        role="tree"
        aria-label={
          matched === null
            ? `Markdown files in ${root.name}`
            : `Markdown files in ${root.name} matching ${filter.trim()}`
        }
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        {rows.map((row) => (
          <TreeRow
            key={row.entry.path}
            row={row}
            href={base && row.entry.kind === 'file' ? fileUrlFor(base, row.entry.path) : null}
            current={row.entry.path === currentPath}
            focused={row.entry.path === focusPath}
            busy={loading.has(row.entry.path)}
            onFocus={() => setFocusPath(row.entry.path)}
            onActivate={() =>
              row.entry.kind === 'directory' ? void toggle(row.entry) : void open(row.entry)
            }
          />
        ))}

        {matched?.length === 0 ? (
          <p className="mdv-side-empty">No files match that.</p>
        ) : null}

        {matched === null && rootListing && rootListing.entries.length === 0 ? (
          <p className="mdv-side-empty">No markdown files in this folder.</p>
        ) : null}

        {/* Said whenever it is true, not only when nothing was found: a filter
            that searched half the folder and found something is exactly the
            case where a reader would otherwise stop looking. */}
        {matched !== null && partiallyRead ? (
          <p className="mdv-folder-note">
            Only folders you have opened are searched. Expand one to include it.
          </p>
        ) : null}

        {[...listings].some(([, listing]) => listing.truncated) ? (
          <p className="mdv-folder-note">
            Some directories held too many entries to list in full.
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * One row.
 *
 * A file whose real address is known renders as an anchor, so a plain click is
 * an ordinary navigation and a modified one does what the reader expects of any
 * link. Everything else is a button. Both carry `role="treeitem"`, and the
 * container's keydown handler does the moving — the roving tabindex is the only
 * state a row owns.
 */
function TreeRow({
  row,
  href,
  current,
  focused,
  busy,
  onFocus,
  onActivate,
}: {
  row: Row;
  href: string | null;
  current: boolean;
  focused: boolean;
  busy: boolean;
  onFocus: () => void;
  onActivate: () => void;
}) {
  const { entry, depth, expanded, position, size } = row;

  const shared = {
    className: 'mdv-folder-row',
    'data-mdv-path': entry.path,
    'data-kind': entry.kind,
    role: 'treeitem',
    'aria-level': depth + 1,
    'aria-posinset': position,
    'aria-setsize': size,
    'aria-current': current ? ('page' as const) : undefined,
    tabIndex: focused ? 0 : -1,
    // Depth as a custom property so one padding rule covers every level.
    style: { '--mdv-folder-depth': depth } as CSSProperties,
    onFocus,
  };

  const label = (
    <>
      {entry.kind === 'directory' ? (
        <FolderCaret open={expanded} busy={busy} />
      ) : (
        <FileIcon />
      )}
      <span className="mdv-folder-label">{entry.name}</span>
    </>
  );

  if (href) {
    return (
      <a {...shared} href={href}>
        {label}
      </a>
    );
  }

  return (
    <button
      {...shared}
      type="button"
      aria-expanded={entry.kind === 'directory' ? expanded : undefined}
      onClick={onActivate}
    >
      {label}
    </button>
  );
}

/** The directory part of a path, or '' for a file at the root. */
function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/**
 * The listings, in painted order.
 *
 * Flat rather than nested `<ul>`s: `aria-level` carries the depth for assistive
 * technology, and an array indexed by screen position is what makes arrow-key
 * movement one subtraction instead of a tree walk.
 */
function flatten(
  listings: Map<string, DirectoryListing>,
  opened: Set<string>,
): Row[] {
  const rows: Row[] = [];

  const walk = (path: string, depth: number) => {
    const entries = listings.get(path)?.entries ?? [];
    entries.forEach((entry, index) => {
      const expanded = entry.kind === 'directory' && opened.has(entry.path);
      rows.push({
        entry,
        depth,
        expanded,
        position: index + 1,
        size: entries.length,
      });
      if (expanded) walk(entry.path, depth + 1);
    });
  };

  walk('', 0);
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

function FolderCaret({ open, busy }: { open: boolean; busy: boolean }) {
  return (
    <svg
      className="mdv-folder-caret"
      data-open={open ? '' : undefined}
      data-busy={busy ? '' : undefined}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      className="mdv-folder-icon"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4 2.2h4.6L12 5.6v8.2H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8.4 2.4v3.4h3.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
