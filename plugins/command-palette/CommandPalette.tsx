import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import {
  buildFileItems,
  buildHeadingItems,
  buildSettingItems,
  createMatcher,
  PALETTE_FIELDS,
  type PaletteFile,
  type PaletteItem,
} from '../../lib/commands.ts';
import {
  FOLDER_DOCUMENT_SCHEME,
  PALETTE_RESULT_LIMIT,
  PALETTE_SOURCES,
  type PaletteSource,
} from '../../lib/config.ts';
import { listRecentDocuments } from '../../lib/document-state.ts';
import { useDocument, usePlugin, usePluginHost } from '../../lib/plugins/react.tsx';
import type { Command } from '../../lib/plugins/types.ts';
import { DEFAULT_SETTINGS, saveSettings, type Settings } from '../../lib/settings.ts';

import { paletteCommands } from './plugin.ts';
import { useFuzzy } from '../../components/FilterBox.tsx';

import './command-palette.css';

/** Keystroke settling time before the list is rebuilt. Matches the search panel. */
const DEBOUNCE_MS = 90;

/** How long the count has to hold still before it is announced. */
const ANNOUNCE_MS = 550;

/** Recent documents offered. Beyond this the list stops being "recent". */
const RECENT_LIMIT = 15;

/** Where a chosen heading is parked, matching the outline's own jump offset. */
const JUMP_OFFSET_PX = 24;

const noopSubscribe = () => () => {};

/**
 * What the rows read from before the plugin's own settings have loaded.
 *
 * A frame, at most: `setup` reads storage as it starts. The defaults are the
 * right stand-in because every row that shows a value shows a real one the
 * moment the read lands, and a palette that renders nothing until storage
 * answers is a palette that feels slower than the key that opened it.
 */
const EMPTY_SETTINGS: Settings = { ...DEFAULT_SETTINGS };

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ctrl/Cmd+K: one field over everything the viewer can do or go to.
 *
 * A sibling of quick find rather than a variant of it, and the difference is
 * what is being searched. Quick find reads the *document* — a literal string,
 * every occurrence, painted in place. This reads a list of *discrete things*:
 * commands, settings, headings, files. That is why fuzzy matching is right here
 * and would be wrong there, and why the two share no code beyond the shell's
 * conventions.
 *
 * Every row says what kind of thing it is, because the alternative is a list in
 * which jumping to a heading called "Export" and running the command called
 * "Export as HTML" are indistinguishable until Enter has already been pressed.
 *
 * The palette owns none of the abilities it offers, which is unchanged — what
 * changed is how it finds out about them. Exporting and comparing arrive as
 * capabilities from the plugins that implement them, the folder's file list and
 * its picker from the Files tab the same way, and everything else in the list
 * arrives through `ctx.commands`. Anything absent is left out entirely.
 *
 * What is *not* here any more: the `open` state, the window listener that
 * toggled it, the ctrl/cmd+K handling, the Escape branch, the two-stop Tab trap,
 * the focus capture and restore, and the `z-index: 60` scrim layer. Every one of
 * those is the overlay host's now.
 */
export function CommandPalette({ close }: { close: () => void }) {
  const ctx = usePlugin();
  const host = usePluginHost();
  const doc = useDocument();

  // One subscription for every capability this reads: the registry bumps a
  // counter whenever anything is provided or withdrawn, which is exactly when a
  // row appears or disappears.
  useSyncExternalStore(host.capabilities.store.subscribe, () =>
    host.capabilities.store.get(),
  );
  const palette = ctx.capabilities.use('command-palette');
  const exporter = ctx.capabilities.use('export');
  const differ = ctx.capabilities.use('diff');
  const toggleRaw = ctx.capabilities.use('document.toggleRaw');
  const browser = ctx.capabilities.use('files.browser');

  const settings = useSyncExternalStore(
    palette?.settings.subscribe ?? noopSubscribe,
    () => palette?.settings.get() ?? EMPTY_SETTINGS,
  );
  const restart = useSyncExternalStore(
    palette?.restarts.subscribe ?? noopSubscribe,
    () => palette?.restarts.get() ?? 0,
  );
  const folder = useSyncExternalStore(
    browser?.subscribe ?? noopSubscribe,
    () => browser?.get(),
  );

  // Commands are read the same way a region's contributions are: from the
  // registry, through its store, so a plugin enabled while the palette is open
  // shows up without the palette knowing that plugin exists.
  const commands = useSyncExternalStore(host.commands.store.subscribe, () =>
    host.commands.store.get(),
  );

  const headings = doc.headings;
  const documentUrl = doc.url;
  const showRaw = doc.isRaw;

  const [query, setQuery] = useState('');
  const [settled, setSettled] = useState('');
  const [current, setCurrent] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const [recent, setRecent] = useState<PaletteFile[]>([]);

  const fuse = useFuzzy();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const listId = useId();
  const optionId = (position: number) => `${listId}-${position}`;

  const apply = useCallback((patch: Partial<Settings>) => void saveSettings(patch), []);

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
    const folderFiles = buildFileItems(folder?.files ?? [], (file) =>
      folder?.open(file.id),
    );
    const recentFiles = buildFileItems(recent, (file) => {
      location.assign(file.id);
    });

    return [
      // Every ability below is a capability, and every absent one removes its
      // row. The mapping is in `plugin.ts` so that rule can be a test.
      ...paletteCommands({
        settings,
        applySettings: apply,
        showRaw,
        toggleRaw,
        exporter,
        differ,
        folder,
      }),
      // Everyone else's commands, read exactly the way anyone would: presentation
      // registered "Present document", quick find registered "Find in document…",
      // and the palette contributed its own. It knows none of their names.
      ...contributed(commands),
      ...buildSettingItems(settings, apply),
      ...buildHeadingItems(headings, goToHeading),
      ...folderFiles,
      ...recentFiles,
    ];
  }, [
    settings,
    apply,
    toggleRaw,
    showRaw,
    exporter,
    differ,
    folder,
    commands,
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

  /* --- opening ------------------------------------------------------------ */

  /**
   * Start again, on every re-press of the shortcut.
   *
   * The host focuses the first focusable thing in an overlay — which is this
   * field — but it does not *select* what is in it, and `OverlayOptions` has no
   * `initialFocus` to say so. And "already open" is not a close: ctrl/cmd+K
   * pressed a second time means "start a new search", which `openOverlay` being
   * idempotent per id cannot express. `plugin.ts` bumps a counter for it, and
   * this is what reads it.
   */
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    if (restart > 0) {
      setQuery('');
      setSettled('');
      setCurrent(0);
    }
  }, [restart]);

  // Recent documents are read when the palette opens rather than at page load:
  // it is a storage round-trip for a list nobody has asked to see yet, and it
  // must be current each time. The palette is only mounted while it is showing,
  // so "when it opens" is now simply "on mount".
  useEffect(() => {
    let alive = true;
    void listRecentDocuments().then((entries) => {
      if (!alive) return;
      setRecent(toRecentFiles(entries, documentUrl));
    });

    return () => {
      alive = false;
    };
  }, [documentUrl]);

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
    const timer = setTimeout(() => {
      const trimmed = settled.trim();
      if (trimmed.length === 0) setAnnouncement('');
      else if (total === 0) setAnnouncement(`Nothing matches ${trimmed}`);
      else setAnnouncement(`${total} ${total === 1 ? 'result' : 'results'} for ${trimmed}`);
    }, ANNOUNCE_MS);

    return () => clearTimeout(timer);
  }, [settled, total]);

  // Keep the active row inside the palette's own scroller. `nearest` so it can
  // never scroll the page behind it.
  useEffect(() => {
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(current))}`)
      ?.scrollIntoView({ block: 'nearest' });
    // `optionId` is derived from `listId`, which is stable for this instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, results, listId]);

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
    // events from a field, but `t`, `r` and `d` are claimed by listeners of
    // their own, and stopping propagation at the dialog is the one place that
    // covers all of them at once. It does not reach the plugin host's shortcut
    // registry, which captures — but every binding there is either modified or
    // skipped while the reader is typing, and the field has focus.
    event.stopPropagation();

    // Mid-IME composition every key belongs to the input method, including the
    // Enter that commits a candidate. React does not surface this on its own
    // synthetic event, so it is read off the native one.
    if (event.nativeEvent.isComposing) return;

    switch (event.key) {
      // No Escape branch: the overlay host closes the top of the stack, which is
      // this. No Tab branch either — containment is the layer's, and the trap it
      // does is a scan of the focusable descendants rather than the wrap between
      // two stops this used to hard-code.
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
    }
  };

  const groups = groupBySource(results);

  return (
    <div className="mdv-palette-layer" data-mdv-chrome>
      {/* Dismissing by clicking away is still this component's, because the host
          has no opinion about it: the overlay surface is inert to the document
          beneath, but nothing there says a click on the empty part of a modal
          closes it. */}
      <div className="mdv-palette-scrim" onMouseDown={close} aria-hidden="true" />

      {/* No `role="dialog"` and no `aria-modal`: the overlay surface around this
          carries both, and a second one inside it would be announced twice. */}
      <div className="mdv-palette" onKeyDown={onDialogKeyDown}>
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

/**
 * Everyone else's commands, as rows.
 *
 * The palette used to *be* the command registry: `PALETTE_COMMANDS` in
 * lib/config.ts listed every action in the viewer, and a feature that wanted one
 * edited that list and then edited `buildCommands` to give it a handler. A
 * plugin cannot do either — which is the point. It calls `ctx.commands.add` and
 * appears here, and the palette never learns its name.
 *
 * `category` becomes the row's second line rather than a group of its own: the
 * source column already says "Command", and a reader scanning for "present"
 * wants to know it comes from presentation, not to find it filed under a heading
 * they have to scroll to.
 */
function contributed(commands: readonly Command[]): PaletteItem[] {
  return commands.map((command) => ({
    id: `plugin-command:${command.id}`,
    source: 'command' as const,
    title: command.title,
    detail: command.category,
    keywords: command.category,
    hint: command.hint,
    run: () => void command.run(),
  }));
}

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
