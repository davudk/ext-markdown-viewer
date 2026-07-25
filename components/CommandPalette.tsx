import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  buildCommands,
  buildFileItems,
  buildHeadingItems,
  buildSettingItems,
  createMatcher,
  getFolder,
  loadFuse,
  subscribeFolder,
  PALETTE_FIELDS,
  type FolderRegistration,
  type FuseConstructor,
  type PaletteFile,
  type PaletteItem,
} from '@/lib/commands';
import {
  COMMAND_PALETTE_KEY,
  FOLDER_DOCUMENT_SCHEME,
  PALETTE_RESULT_LIMIT,
  PALETTE_SOURCES,
  type ExportFormat,
  type PaletteSource,
} from '@/lib/config';
import { listRecentDocuments } from '@/lib/document-state';
import type { Heading } from '@/lib/markdown';
import { saveSettings, type Settings } from '@/lib/settings';

import './command-palette.css';

/** Keystroke settling time before the list is rebuilt. Matches the search panel. */
const DEBOUNCE_MS = 90;

/** How long the count has to hold still before it is announced. */
const ANNOUNCE_MS = 550;

/** Recent documents offered. Beyond this the list stops being "recent". */
const RECENT_LIMIT = 15;

/** Where a chosen heading is parked, matching the outline's own jump offset. */
const JUMP_OFFSET_PX = 24;

/* -------------------------------------------------------------------------- */
/* Loading Fuse                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Fuse's constructor once it is available, and null until then.
 *
 * Exported because the two sidebar filter boxes need exactly the same thing and
 * `loadFuse` memoises across all three — the module is resolved once per page
 * however many surfaces ask for it. Nothing here blocks on it: every caller
 * builds a working substring matcher from the null and swaps in the fuzzy one
 * on the render after it arrives.
 */
export function useFuzzy(): FuseConstructor | null {
  const [fuse, setFuse] = useState<FuseConstructor | null>(null);

  useEffect(() => {
    let alive = true;
    void loadFuse().then((loaded) => {
      // Wrapped in an updater: a constructor *is* a function, and handing one
      // to a setter directly would have React call it as a reducer.
      if (alive && loaded) setFuse(() => loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  return fuse;
}

/* -------------------------------------------------------------------------- */
/* The filter box the two sidebar panels share                                 */
/* -------------------------------------------------------------------------- */

/**
 * A one-line filter over a list that is already on screen.
 *
 * Here rather than in `Toc.tsx` or `FolderBrowser.tsx` because both need it and
 * because it is the same idea as the palette at a smaller scale — the same
 * matcher, the same "typing narrows a list of discrete things", the same
 * stylesheet. Two copies of this would be two places for the announcement
 * timing and the escape-to-clear behaviour to drift apart.
 *
 * Deliberately *not* a combobox: the lists it filters are a `<nav>` of links
 * and a `role="tree"`, both of which keep their own keyboard model. This types,
 * clears, and counts; it never moves the selection.
 */
export function FilterBox({
  value,
  onChange,
  label,
  placeholder,
  count,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name. Visible only as the placeholder. */
  label: string;
  placeholder: string;
  /** Rows showing now, or null when nothing is filtered. */
  count: number | null;
  /** Id of the list being filtered. */
  controls?: string;
}) {
  const [announcement, setAnnouncement] = useState('');

  // Same bargain as the palette's own live region: a count announced while it
  // is still changing turns every keystroke into an interruption.
  useEffect(() => {
    if (value.trim().length === 0 || count === null) {
      setAnnouncement('');
      return;
    }

    const timer = setTimeout(() => {
      setAnnouncement(count === 0 ? 'No matches' : `${count} ${count === 1 ? 'match' : 'matches'}`);
    }, ANNOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, count]);

  return (
    <div className="mdv-filter">
      <input
        className="mdv-filter-field"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-controls={controls}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Escape empties the box rather than reaching the panel behind it,
          // which is what every filter field in every file tree does.
          if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            onChange('');
          }
        }}
      />

      {count !== null ? (
        <span className="mdv-filter-count" aria-hidden="true">
          {count}
        </span>
      ) : null}

      {value.length > 0 ? (
        <button
          type="button"
          className="mdv-filter-clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          title="Clear (Escape)"
          onClick={() => onChange('')}
        >
          <CloseIcon />
        </button>
      ) : null}

      <div className="mdv-filter-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Props                                                                       */
/* -------------------------------------------------------------------------- */

export interface CommandPaletteProps {
  /** The outline, so every heading is reachable without opening the sidebar. */
  headings: Heading[];
  /** Current settings. Rows read their values from here and act through `applySettings`. */
  settings: Settings;
  /** The document on screen, so it is not offered as somewhere to go. */
  documentUrl: string;
  /** Which view the reader is in, for the raw-view row's hint. */
  showRaw?: boolean;
  /** Present when the shell can switch views; absent removes "Toggle raw text". */
  onToggleRaw?: () => void;
  /**
   * Formats the export add-on can produce right now. Absent or empty removes
   * both export rows — an export that cannot run is worse than no row at all.
   */
  exportFormats?: readonly ExportFormat[];
  onExport?: (format: ExportFormat) => void;
  /** Overrides the folder picker the Files tab publishes. Rarely needed. */
  onOpenFolder?: () => void;
  /** Absent removes "Compare files…", as does having no folder open. */
  onCompareFiles?: () => void;
  /** Absent removes "Open settings…". A content script cannot reach the options page alone. */
  onOpenSettings?: () => void;
  /** Defaults to `saveSettings`. */
  applySettings?: (patch: Partial<Settings>) => void;
  /** Defaults to `window.print`. */
  print?: () => void;
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ctrl/Cmd+K: one field over everything the viewer can do or go to.
 *
 * A sibling of the search panel rather than a variant of it, and the difference
 * is what is being searched. Search reads the *document* — a literal string,
 * every occurrence, painted in place. This reads a list of *discrete things*:
 * commands, settings, headings, files. That is why fuzzy matching is right here
 * and would be wrong there, and why the two share no code beyond the shell's
 * conventions.
 *
 * Every row says what kind of thing it is, because the alternative is a list in
 * which jumping to a heading called "Export" and running the command called
 * "Export as HTML" are indistinguishable until Enter has already been pressed.
 *
 * The palette owns none of the capabilities it offers. Exporting, the raw view
 * and comparing files arrive as props; the folder picker and the folder's file
 * list arrive from `FolderBrowser` through the registry in `lib/commands.ts`.
 * Anything that did not arrive is left out of the list entirely.
 */
export function CommandPalette({
  headings,
  settings,
  documentUrl,
  showRaw,
  onToggleRaw,
  exportFormats,
  onExport,
  onOpenFolder,
  onCompareFiles,
  onOpenSettings,
  applySettings,
  print,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [settled, setSettled] = useState('');
  const [current, setCurrent] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [recent, setRecent] = useState<PaletteFile[]>([]);
  const [folder, setFolder] = useState<FolderRegistration>(getFolder);

  const fuse = useFuzzy();

  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // The window listener is bound once; this is how it reads current state.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  const listId = useId();
  const optionId = (position: number) => `${listId}-${position}`;

  /* --- what the shell was able to supply ---------------------------------- */

  // `FolderBrowser` is two components below the palette's own parent, so its
  // file list and its picker are published rather than passed. See the registry
  // in lib/commands.ts for why that is not prop-drilling avoidance for its own
  // sake — the components in between are not ours to edit.
  useEffect(() => subscribeFolder(setFolder), []);

  const apply = useCallback(
    (patch: Partial<Settings>) => {
      if (applySettings) applySettings(patch);
      else void saveSettings(patch);
    },
    [applySettings],
  );

  const close = useCallback(() => setOpen(false), []);

  /** Runs a row and gets out of the way. Every row closes the palette. */
  const activate = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      close();
      item.run();
    },
    [close],
  );

  const goToHeading = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target) return;

    const top = target.getBoundingClientRect().top + window.scrollY - JUMP_OFFSET_PX;
    window.scrollTo({
      top: Math.max(0, top),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
    // Same bargain as the outline's own links: the address stays shareable and
    // Back keeps working, without a fragment navigation cancelling the scroll.
    history.pushState(null, '', `#${id}`);
  }, []);

  /* --- the list ----------------------------------------------------------- */

  const items = useMemo(() => {
    const folderFiles = buildFileItems(folder.files, (file) => folder.open(file.id));
    const recentFiles = buildFileItems(recent, (file) => {
      location.assign(file.id);
    });

    return [
      ...buildCommands({
        settings,
        applySettings: apply,
        toggleRaw: onToggleRaw,
        showRaw,
        exportFormats,
        exportAs: onExport,
        print: print ?? (() => window.print()),
        openFolder: onOpenFolder ?? (folder.supported ? folder.choose : undefined),
        // Nothing to compare a document against until a folder is open, so the
        // row is absent rather than opening a picker with one side missing.
        compareFiles: folder.rootName !== null ? onCompareFiles : undefined,
        openSettings: onOpenSettings,
      }),
      ...buildSettingItems(settings, apply),
      ...buildHeadingItems(headings, goToHeading),
      ...folderFiles,
      ...recentFiles,
    ];
  }, [
    settings,
    apply,
    onToggleRaw,
    showRaw,
    exportFormats,
    onExport,
    print,
    onOpenFolder,
    onCompareFiles,
    onOpenSettings,
    folder,
    headings,
    recent,
    goToHeading,
  ]);

  // One index per list, not per keystroke: building it is the expensive half of
  // fuzzy matching, and the list only changes when the document or the folder
  // does. Rebuilt when Fuse arrives, which is what swaps the fallback out.
  const match = useMemo(
    () => createMatcher(items, PALETTE_FIELDS, fuse, PALETTE_RESULT_LIMIT),
    [items, fuse],
  );

  const results = useMemo(() => {
    const trimmed = settled.trim();
    if (trimmed.length === 0) return items.slice(0, PALETTE_RESULT_LIMIT);
    return match(trimmed).map((result) => result.item);
  }, [items, match, settled]);

  const total = results.length;

  /* --- opening and closing ------------------------------------------------ */

  const openPalette = useCallback(() => {
    if (openRef.current) {
      // Already open: the shortcut means "start again", so the standing query is
      // selected rather than the palette closing under a reader's habit.
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }

    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;
    setQuery('');
    setSettled('');
    setCurrent(0);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === COMMAND_PALETTE_KEY
      ) {
        event.preventDefault();
        openPalette();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openPalette]);

  // Focus in on open, and back exactly where it came from on close. Both after
  // the commit: restoring before the dialog unmounts would hand focus to an
  // element the dialog is about to take it back from on its way out.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }

    const restore = restoreRef.current;
    restoreRef.current = null;
    if (restore?.isConnected) restore.focus();
  }, [open]);

  // Recent documents are read when the palette opens rather than on mount: it
  // is a storage round-trip for a list nobody has asked to see yet, and it must
  // be current each time rather than as of page load.
  useEffect(() => {
    if (!open) return;

    let alive = true;
    void listRecentDocuments().then((entries) => {
      if (!alive) return;
      setRecent(toRecentFiles(entries, documentUrl));
    });

    return () => {
      alive = false;
    };
  }, [open, documentUrl]);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // A new query is a new list; staying on row 7 of a list that has three rows
  // would leave nothing selected and Enter doing nothing.
  useEffect(() => setCurrent(0), [settled]);

  // Polite and late, like the search panel's: announcing a count that is still
  // changing turns every keystroke into an interruption.
  useEffect(() => {
    if (!open) {
      setAnnouncement('');
      return;
    }

    const timer = setTimeout(() => {
      const trimmed = settled.trim();
      if (trimmed.length === 0) setAnnouncement('');
      else if (total === 0) setAnnouncement(`Nothing matches ${trimmed}`);
      else setAnnouncement(`${total} ${total === 1 ? 'result' : 'results'} for ${trimmed}`);
    }, ANNOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, settled, total]);

  // Keep the active row inside the palette's own scroller. `nearest` so it can
  // never scroll the page behind it.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(current))}`)
      ?.scrollIntoView({ block: 'nearest' });
    // `optionId` is derived from `listId`, which is stable for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current, results, listId]);

  /* --- keys inside the dialog --------------------------------------------- */

  const step = useCallback(
    (delta: number) => {
      if (total === 0) return;
      setCurrent((at) => ((at + delta) % total + total) % total);
    },
    [total],
  );

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Everything the reader types while this is open belongs to this, including
    // the keys they do not press here. `useKeyboardShortcuts` already ignores
    // events from a field, but `t`, `r`, `d` and `/` are claimed by several
    // components with listeners of their own, and stopping propagation at the
    // dialog is the one place that covers all of them at once.
    event.stopPropagation();

    // Mid-IME composition every key belongs to the input method, including the
    // Enter that commits a candidate. React does not surface this on its own
    // synthetic event, so it is read off the native one.
    if (event.nativeEvent.isComposing) return;

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        return;
      case 'Home':
        event.preventDefault();
        setCurrent(0);
        return;
      case 'End':
        event.preventDefault();
        setCurrent(Math.max(0, total - 1));
        return;
      case 'Enter':
        event.preventDefault();
        activate(results[current]);
        return;
      case 'Tab': {
        // Two tab stops — the field and the close button — so the trap is a
        // wrap between them rather than a scan for focusable descendants.
        event.preventDefault();
        const onField = document.activeElement === inputRef.current;
        (onField ? closeRef.current : inputRef.current)?.focus();
        return;
      }
      default:
        // Ctrl/Cmd+K again selects the query rather than escaping through to
        // the window handler this dialog is now shadowing.
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === COMMAND_PALETTE_KEY
        ) {
          event.preventDefault();
          inputRef.current?.select();
        }
    }
  };

  if (!open) return null;

  const groups = groupBySource(results);

  return (
    <div className="mdv-palette-layer" data-mdv-chrome>
      {/* The scrim is what makes this modal in practice: a click outside is the
          commonest way to dismiss a palette, and it must not reach the document
          underneath. */}
      <div className="mdv-palette-scrim" onMouseDown={close} aria-hidden="true" />

      <div
        className="mdv-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKeyDown}
      >
        <div className="mdv-palette-bar">
          <CommandIcon />

          <input
            ref={inputRef}
            className="mdv-palette-field"
            type="text"
            role="combobox"
            value={query}
            placeholder="Search commands, settings, headings and files"
            aria-label="Search commands, settings, headings and files"
            aria-expanded={total > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={total > 0 ? optionId(current) : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />

          <button
            type="button"
            ref={closeRef}
            className="mdv-palette-close"
            aria-label="Close command palette"
            title="Close (Escape)"
            onClick={close}
          >
            <CloseIcon />
          </button>
        </div>

        <ul
          ref={listRef}
          id={listId}
          className="mdv-palette-results"
          role="listbox"
          aria-label="Results"
        >
          {groups.map((group) => (
            <li key={group.source} role="group" aria-label={PALETTE_SOURCES[group.source]}>
              <p className="mdv-palette-group" aria-hidden="true">
                {PALETTE_SOURCES[group.source]}
              </p>

              <ul className="mdv-palette-rows" role="none">
                {group.positions.map((position) => {
                  const item = results[position];
                  return (
                    <li
                      key={item.id}
                      id={optionId(position)}
                      className="mdv-palette-row"
                      role="option"
                      aria-selected={position === current}
                      aria-label={`${PALETTE_SOURCES[item.source]}: ${item.title}${
                        item.detail ? `, ${item.detail}` : ''
                      }`}
                      onMouseMove={() => setCurrent(position)}
                      onClick={() => activate(item)}
                    >
                      <span className="mdv-palette-text" aria-hidden="true">
                        <span className="mdv-palette-title">{item.title}</span>
                        {item.detail ? (
                          <span className="mdv-palette-detail">{item.detail}</span>
                        ) : null}
                      </span>

                      {item.hint ? (
                        <span className="mdv-palette-hint" aria-hidden="true">
                          {item.hint}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>

        {total === 0 ? (
          <p className="mdv-palette-empty">
            {settled.trim().length === 0
              ? 'Nothing to show.'
              : `Nothing matches “${settled.trim()}”.`}
          </p>
        ) : null}

        {!fuse && settled.trim().length > 0 ? (
          <p className="mdv-palette-note">Matching exactly — fuzzy search is unavailable.</p>
        ) : null}

        <div className="mdv-palette-live" role="status" aria-live="polite">
          {announcement}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Consecutive results sharing a source, so the list carries one header each. */
function groupBySource(
  results: readonly PaletteItem[],
): { source: PaletteSource; positions: number[] }[] {
  const groups: { source: PaletteSource; positions: number[] }[] = [];

  results.forEach((item, position) => {
    const last = groups[groups.length - 1];
    if (last && last.source === item.source) last.positions.push(position);
    else groups.push({ source: item.source, positions: [position] });
  });

  return groups;
}

/**
 * Remembered documents as rows the palette can offer.
 *
 * Two exclusions, both because the row would not work: the document already on
 * screen, and anything with the `mdv-folder:` scheme — that identity exists
 * precisely because such a file has no address to navigate to, and it is
 * already reachable through the folder's own file list.
 */
function toRecentFiles(
  entries: readonly { url: string; usedAt: number }[],
  documentUrl: string,
): PaletteFile[] {
  const files: PaletteFile[] = [];

  for (const entry of entries) {
    if (files.length >= RECENT_LIMIT) break;
    if (entry.url === documentUrl) continue;
    if (entry.url.startsWith(FOLDER_DOCUMENT_SCHEME)) continue;

    files.push({ id: entry.url, name: basename(entry.url), detail: whereabouts(entry.url) });
  }

  return files;
}

function basename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).pop() ?? url);
  } catch {
    return url;
  }
}

/** The directory a document sits in, host included when it has one. */
function whereabouts(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    parts.pop();
    const directory = decodeURIComponent(parts.join('/'));
    return parsed.protocol === 'file:'
      ? `/${directory}`
      : `${parsed.host}/${directory}`;
  } catch {
    return url;
  }
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

function CommandIcon() {
  return (
    <svg
      className="mdv-palette-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 5.2 5.8 8 3 10.8" />
      <path d="M7.6 11.4h5.4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}
