import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  DEFAULT_DIFF_LAYOUT,
  DEFAULT_DIFF_MODE,
  DIFF_LAYOUT_OPTIONS,
  DIFF_MODE_OPTIONS,
  type DiffLayout,
  type DiffMode,
} from '../../lib/config.ts';
import {
  changeBlocks,
  collapseContext,
  compareRendered,
  compareSource,
  documentBlocks,
  highlightMarkdown,
  loadDiffEngine,
  type CompareRequest,
  type DiffEngine,
  type DiffRow,
  type DiffStats,
} from '../../lib/diff.ts';
import { renderMarkdown } from '../../lib/markdown.ts';
import { useDocument, usePlugin, usePluginHost } from '../../lib/plugins/react.tsx';
import type { Teardown } from '../../lib/plugins/types.ts';

import type { DiffCapability } from './plugin.ts';
import './diff.css';

/** Distance the menu is kept from the edge of the viewport. */
const MENU_MARGIN_PX = 8;

/** What the comparison is currently doing. The menu is its own overlay now. */
type Phase = 'loading' | 'ready' | 'error';

interface Side {
  name: string;
  source: string;
}

/* -------------------------------------------------------------------------- */
/* Reaching the plugin's own state                                             */
/* -------------------------------------------------------------------------- */

/**
 * This plugin's capability, and the file it is pointed at.
 *
 * The three views below are separate overlays with no parent between them, so
 * the subject of the comparison lives in a `Store` in `setup` rather than in
 * React state — the host renders each of them inside this plugin's context, and
 * this is how they find it.
 */
function useDiff(): { differ: DiffCapability | undefined; target: CompareRequest | null } {
  const ctx = usePlugin();
  const host = usePluginHost();

  useSyncExternalStore(host.capabilities.store.subscribe, () =>
    host.capabilities.store.get(),
  );
  const differ = ctx.capabilities.use('diff');

  const target = useSyncExternalStore(
    differ?.target.subscribe ?? noopSubscribe,
    () => differ?.target.get() ?? null,
  );

  return { differ, target };
}

const noopSubscribe = () => () => {};

/* -------------------------------------------------------------------------- */
/* The row menu                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One item, over the row that raised it.
 *
 * A right-click is a question, not a command: nothing is read off disk and no
 * library is loaded until the reader actually picks the item.
 *
 * It is an overlay rather than a portal because everything it needed from one —
 * being above the document, Escape closing it, focus landing on the item and
 * going back to the row afterwards — is what the host does for every overlay. It
 * is positioned inside that surface rather than against the viewport, which is
 * how it stopped carrying a `z-index` of its own.
 */
export function DiffMenu({ close }: { close: () => void }) {
  const { differ, target } = useDiff();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A menu that survives the page scrolling out from under it is a menu
    // floating over the wrong row. The document beneath an overlay is inert but
    // still scrollable, so this is as true as it was.
    const onScroll = () => close();
    // Outside the menu means outside: the overlay surface covers the viewport,
    // so a click anywhere else lands on it rather than on the document.
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [close]);

  if (!target) return null;

  return (
    <div
      ref={menuRef}
      className="mdv-diff-menu"
      data-mdv-chrome
      role="menu"
      aria-label={`Actions for ${target.name}`}
      style={menuPosition(target)}
    >
      <button
        type="button"
        className="mdv-diff-menu-item"
        role="menuitem"
        title={target.path}
        onClick={() => differ?.start()}
      >
        Compare with current file
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The picker                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Choosing the other file without a right-click.
 *
 * The command palette has had a "Compare files…" row in `PALETTE_COMMANDS` since
 * before this feature was a plugin, and it has never once appeared: the shell
 * had no handler to pass, so `buildCommands` dropped it every time. It appears
 * now, and this is what it opens — the open folder's files, and nothing when
 * there is no folder, which is the honest answer rather than an empty dialog.
 */
export function DiffPicker({ close }: { close: () => void }) {
  const ctx = usePlugin();
  const host = usePluginHost();
  const { differ } = useDiff();

  useSyncExternalStore(host.capabilities.store.subscribe, () =>
    host.capabilities.store.get(),
  );
  const browser = ctx.capabilities.use('files.browser');
  const folder = useSyncExternalStore(
    browser?.subscribe ?? noopSubscribe,
    () => browser?.get(),
  );

  const files = folder?.files ?? [];
  const titleId = useId();

  const pick = (id: string, name: string) => {
    if (!folder || !differ) return;
    differ.target.set({
      name,
      path: id,
      // A thunk, not the text: listing files must not read them off disk.
      read: () => folder.read(id),
      anchor: null,
      origin: null,
    });
    differ.start();
  };

  return (
    <div className="mdv-diff" data-mdv-chrome>
      <div className="mdv-diff-dialog mdv-diff-picker" aria-labelledby={titleId}>
        <header className="mdv-diff-bar">
          <h2 className="mdv-diff-title" id={titleId}>
            Compare with…
          </h2>
          <div className="mdv-diff-actions">
            <button
              type="button"
              className="mdv-diff-tool"
              aria-label="Close"
              title="Close (Esc)"
              onClick={close}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="mdv-diff-scroll" tabIndex={-1}>
          {files.length === 0 ? (
            <p className="mdv-diff-note" role="status">
              No folder is open, so there is nothing to compare against. Open one
              from the Files tab in the sidebar.
            </p>
          ) : (
            <ul className="mdv-diff-picks">
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="mdv-diff-pick"
                    title={file.id}
                    onClick={() => pick(file.id, file.name)}
                  >
                    <span className="mdv-diff-pick-name">{file.name}</span>
                    <span className="mdv-diff-pick-where">{file.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Comparing the open document against another file from the folder tree.
 *
 * Three things arrive here from three different places, and keeping them
 * straight is most of the design:
 *
 *   · **The request.** `FolderBrowser` reports that a row was right-clicked (or
 *     had its menu opened from the keyboard) and hands over a thunk that can
 *     read the file. Nothing is read, and no library is loaded, until the reader
 *     actually picks the menu item — a right-click is a question, not a command.
 *   · **The engine.** jsdiff is an on-demand add-on; `loadDiffEngine` asks the
 *     service worker to inject it and resolves with the functions it publishes.
 *     Every failure on that path ends up on screen, because the alternative is a
 *     spinner that never stops.
 *   · **The other document.** Rendering it means running it back through
 *     `renderMarkdown`, the same pipeline the page itself used. Only the
 *     `{ html, headings }` contract is relied on.
 *
 * The view is read-only by construction. There is no merge, no edit and no
 * write path anywhere in this component: it holds two strings it was given and
 * draws them side by side.
 */
export function DiffView({ close }: { close: () => void }) {
  const ctx = usePlugin();
  const doc = useDocument();
  const { target: request } = useDiff();

  const currentSource = doc.source;
  const currentName = documentName(doc.url);

  const [phase, setPhase] = useState<Phase>('loading');
  const [engine, setEngine] = useState<DiffEngine | null>(null);
  const [other, setOther] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<DiffMode>(DEFAULT_DIFF_MODE);
  const [layout, setLayout] = useState<DiffLayout>(DEFAULT_DIFF_LAYOUT);
  const [swapped, setSwapped] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);

  const titleId = useId();

  /* ------------------------------------------------------------------------ */
  /* Starting the comparison                                                   */
  /* ------------------------------------------------------------------------ */

  const start = useCallback(async () => {
    if (!request) return;

    setPhase('loading');
    setError(null);
    setEngine(null);
    setOther(null);

    try {
      // Both at once: reading the file is disk-bound and injecting the add-on
      // is a round trip through the service worker, and neither needs the other.
      const [source, loaded] = await Promise.all([
        request.read(),
        loadDiffEngine(),
      ]);
      setOther({ name: request.name, source });
      setEngine(loaded);
      setPhase('ready');
    } catch (failure) {
      setError(describe(failure));
      setPhase('error');
    }
  }, [request]);

  /* ------------------------------------------------------------------------ */
  /* The comparison itself                                                     */
  /* ------------------------------------------------------------------------ */

  const current: Side = { name: currentName, source: currentSource };
  const before = swapped ? other : current;
  const after = swapped ? current : other;

  const comparison = useMemo(() => {
    if (!engine || !before || !after) return null;

    try {
      if (mode === 'rendered') {
        const result = compareRendered(
          renderedBlocks(before.source),
          renderedBlocks(after.source),
          engine,
        );
        return { rows: result.rows, stats: result.stats, failed: null };
      }

      const result = compareSource(before.source, after.source, engine);
      return {
        rows: layout === 'split' ? result.split : result.unified,
        stats: result.stats,
        failed: null,
      };
    } catch (failure) {
      return { rows: [] as DiffRow[], stats: null, failed: describe(failure) };
    }
  }, [engine, before?.source, after?.source, mode, layout]);

  // Folding is a view of the rows, not a property of them, so it is applied
  // after the comparison rather than inside it — reopening a gap must not cost
  // a re-diff of the whole file.
  const rows = useMemo(
    () =>
      comparison && mode === 'source'
        ? collapseContext(comparison.rows, expanded)
        : (comparison?.rows ?? []),
    [comparison, mode, expanded],
  );

  const blocks = useMemo(() => changeBlocks(rows), [rows]);

  // A layout or mode change renumbers the rows; landing on a block index that
  // no longer exists would disable navigation with no way back.
  useEffect(() => {
    setCursor((at) => Math.min(at, Math.max(0, blocks.length - 1)));
  }, [blocks.length]);

  const goto = useCallback(
    (index: number) => {
      if (blocks.length === 0) return;

      const wrapped = (index + blocks.length) % blocks.length;
      setCursor(wrapped);

      scrollRef.current
        ?.querySelector(`[data-mdv-change="${blocks[wrapped].index}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'auto' });
    },
    [blocks],
  );

  /* ------------------------------------------------------------------------ */
  /* Modal behaviour, and the keys                                             */
  /* ------------------------------------------------------------------------ */

  // The comparison begins when the overlay does. It used to begin on a click in
  // the row menu, which is a separate overlay now — so this is the same moment,
  // named by where it happens instead of by which button caused it.
  useEffect(() => {
    void start();
  }, [start]);

  /**
   * Everything a modal needs is the host's: `inert` on the document beneath,
   * the focus trap, focus restore, Escape, the stacking. What used to be here —
   * an `inert` attribute, a `focusin` backstop, a Tab trap, a `z-index` and a
   * portal — is deleted rather than reimplemented, which is the entire point of
   * `openOverlay`. The scroll lock is the one exception and lives in `plugin.ts`
   * with a note saying why.
   *
   * The navigation keys move to the host's registry for a reason beyond tidiness:
   * `n`/`p`/`j`/`k`/`s` were caught on the dialog and stopped from propagating,
   * which worked against listeners that bubble and does not against the plugin
   * host's, which captures. `p` in particular is presentation mode's key.
   * Bindings are tried newest-first and the first to handle wins, so registering
   * these while the comparison is up is what actually claims them.
   */
  useEffect(() => {
    const bindings: Teardown[] = [
      ctx.shortcuts.add({ key: 'n', whileTyping: true, run: press(() => goto(cursor + 1)) }),
      ctx.shortcuts.add({ key: 'j', whileTyping: true, run: press(() => goto(cursor + 1)) }),
      ctx.shortcuts.add({ key: 'p', whileTyping: true, run: press(() => goto(cursor - 1)) }),
      ctx.shortcuts.add({ key: 'k', whileTyping: true, run: press(() => goto(cursor - 1)) }),
      ctx.shortcuts.add({
        key: 's',
        whileTyping: true,
        run: press(() => setSwapped((value) => !value)),
      }),
    ];
    return () => bindings.forEach((stop) => stop());
  }, [ctx, goto, cursor]);

  /* ------------------------------------------------------------------------ */

  if (!request) return null;

  const failed = comparison?.failed ?? null;
  const stats: DiffStats | null = comparison?.stats ?? null;

  return (
    <div
      className="mdv-diff"
      // Read by the print rule in diff.css, which strips chrome by attribute
      // rather than by class name the way viewer.css does inside the shell.
      data-mdv-chrome
    >
      {/* No `role="dialog"` and no `aria-modal`: the host's overlay surface is
          the dialog and carries both, and nesting a second one inside it would
          announce two. */}
      <div className="mdv-diff-dialog" aria-labelledby={titleId}>
        <header className="mdv-diff-bar">
          <h2 className="mdv-diff-title" id={titleId}>
            <span className="mdv-diff-name" data-side="before">
              {before?.name ?? '…'}
            </span>
            <button
              type="button"
              className="mdv-diff-tool"
              aria-label="Swap sides"
              title="Swap sides (s)"
              disabled={phase !== 'ready'}
              onClick={() => setSwapped((value) => !value)}
            >
              <SwapIcon />
            </button>
            <span className="mdv-diff-name" data-side="after">
              {after?.name ?? '…'}
            </span>
          </h2>

          <p className="mdv-diff-stats" aria-live="polite">
            {stats ? (
              <>
                <span className="mdv-diff-added">+{stats.added}</span>{' '}
                <span className="mdv-diff-removed">−{stats.removed}</span>
                {blocks.length > 0 ? (
                  <span className="mdv-diff-where">
                    {' '}
                    · change {cursor + 1} of {blocks.length}
                  </span>
                ) : (
                  <span className="mdv-diff-where"> · identical</span>
                )}
              </>
            ) : null}
          </p>

          <div className="mdv-diff-actions">
            <Choice
              label="Comparison"
              options={DIFF_MODE_OPTIONS}
              value={mode}
              disabled={phase !== 'ready'}
              onSelect={setMode}
            />
            {mode === 'source' ? (
              <Choice
                label="Layout"
                options={DIFF_LAYOUT_OPTIONS}
                value={layout}
                disabled={phase !== 'ready'}
                onSelect={setLayout}
              />
            ) : null}

            <button
              type="button"
              className="mdv-diff-tool"
              aria-label="Previous change"
              title="Previous change (p)"
              disabled={blocks.length === 0}
              onClick={() => goto(cursor - 1)}
            >
              <ArrowIcon up />
            </button>
            <button
              type="button"
              className="mdv-diff-tool"
              aria-label="Next change"
              title="Next change (n)"
              disabled={blocks.length === 0}
              onClick={() => goto(cursor + 1)}
            >
              <ArrowIcon />
            </button>

            <button
              type="button"
              className="mdv-diff-tool"
              aria-label="Close comparison"
              title="Close (Esc)"
              onClick={close}
            >
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="mdv-diff-scroll" ref={scrollRef} tabIndex={-1}>
          {phase === 'loading' ? (
            <p className="mdv-diff-note" role="status">
              Loading the comparison…
            </p>
          ) : null}

          {phase === 'error' || failed ? (
            <div className="mdv-diff-note" role="alert">
              <p className="mdv-diff-problem">{failed ?? error}</p>
              {phase === 'error' ? (
                <button
                  type="button"
                  className="mdv-diff-retry"
                  onClick={() => void start()}
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}

          {phase === 'ready' && !failed ? (
            <Rows
              rows={rows}
              mode={mode}
              layout={layout}
              beforeName={before?.name ?? ''}
              afterName={after?.name ?? ''}
              onExpand={(at) =>
                setExpanded((current) => new Set(current).add(at))
              }
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The rows                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A table, because that is what this is: two or four aligned columns with a
 * header naming each side. It also gets the line numbers into cells the browser
 * lays out, rather than into pseudo-elements a reader cannot select.
 */
function Rows({
  rows,
  mode,
  layout,
  beforeName,
  afterName,
  onExpand,
}: {
  rows: DiffRow[];
  mode: DiffMode;
  layout: DiffLayout;
  beforeName: string;
  afterName: string;
  onExpand: (at: number) => void;
}) {
  // Rendered comparison is always side by side: a single column of alternating
  // paragraphs from two documents is not something anyone can read.
  const split = mode === 'rendered' || layout === 'split';
  const columns = split ? 4 : 2;

  if (rows.length === 0) {
    return (
      <p className="mdv-diff-note" role="status">
        These two files are identical.
      </p>
    );
  }

  return (
    <table
      className="mdv-diff-table"
      data-mode={mode}
      data-layout={split ? 'split' : 'unified'}
    >
      <caption className="mdv-sr-only">
        {`Differences between ${beforeName} and ${afterName}`}
      </caption>

      <colgroup>
        <col className="mdv-diff-col-num" />
        <col />
        {split ? <col className="mdv-diff-col-num" /> : null}
        {split ? <col /> : null}
      </colgroup>

      <tbody>
        {rows.map((row, at) => {
          if (row.kind === 'gap') {
            return (
              <tr key={`gap-${row.at}`} className="mdv-diff-row" data-kind="gap">
                <td className="mdv-diff-gap" colSpan={columns}>
                  <button
                    type="button"
                    className="mdv-diff-expand"
                    onClick={() => onExpand(row.at ?? at)}
                  >
                    {`Show ${row.hidden} unchanged line${row.hidden === 1 ? '' : 's'}`}
                  </button>
                </td>
              </tr>
            );
          }

          // Only the first row of a run carries the marker, so navigation lands
          // on the top of a change rather than inside it.
          const heads = row.block >= 0 && rows[at - 1]?.block !== row.block;

          return (
            <tr
              key={at}
              className="mdv-diff-row"
              data-kind={row.kind}
              data-mdv-change={heads ? row.block : undefined}
            >
              {split ? (
                <>
                  <Cell row={row} side="before" mode={mode} />
                  <Cell row={row} side="after" mode={mode} />
                </>
              ) : (
                <Cell row={row} side={row.after ? 'after' : 'before'} mode={mode} unified />
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One side of one row: its number, and its content. */
function Cell({
  row,
  side,
  mode,
  unified = false,
}: {
  row: DiffRow;
  side: 'before' | 'after';
  mode: DiffMode;
  unified?: boolean;
}) {
  const cell = row[side];
  const marker = row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' ';

  if (!cell) {
    return (
      <>
        <td className="mdv-diff-num" data-side={side} aria-hidden="true" />
        <td className="mdv-diff-cell" data-side={side} data-empty="" />
      </>
    );
  }

  return (
    <>
      {/* aria-hidden because a screen reader reading "142" before every line of
          a two-hundred-line diff drowns the diff. The marker column below
          carries the meaning instead. */}
      <td className="mdv-diff-num" data-side={side} aria-hidden="true">
        {cell.number}
      </td>
      <td
        className="mdv-diff-cell"
        data-side={side}
        // In a unified diff the +/− is the only thing distinguishing the two,
        // and colour alone must never be it.
        data-marker={unified ? marker : undefined}
      >
        {mode === 'rendered' ? (
          // Already sanitized: it came straight out of `renderMarkdown`, which
          // is the same pipeline that produced the document behind this overlay.
          <div
            className="mdv-diff-rendered"
            dangerouslySetInnerHTML={{ __html: cell.text }}
          />
        ) : (
          <code
            className="mdv-diff-code"
            // hljs escapes everything it does not turn into a token span, and
            // the fallback path in `highlightMarkdown` escapes by hand.
            dangerouslySetInnerHTML={{ __html: highlightMarkdown(cell.text) }}
          />
        )}
      </td>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Bits                                                                        */
/* -------------------------------------------------------------------------- */

/** A small group of mutually exclusive toggles. Buttons, not a `<select>`. */
function Choice<T extends string>({
  label,
  options,
  value,
  disabled,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  disabled: boolean;
  onSelect: (next: T) => void;
}) {
  return (
    <div className="mdv-diff-choice" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="mdv-diff-chip"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The rendered document's blocks, extracted in an inert document.
 *
 * `document.implementation.createHTMLDocument()` parses without loading
 * anything: an `<img>` written into the live DOM starts fetching the moment its
 * src is set, even detached, and extracting blocks is not a reason to pull down
 * every image in a file the reader has not chosen to look at yet.
 */
function renderedBlocks(source: string): string[] {
  const inert = document.implementation.createHTMLDocument('');
  inert.body.innerHTML = renderMarkdown(source).html;
  return documentBlocks(inert.body);
}

function menuPosition(request: CompareRequest) {
  const point =
    request.anchor ??
    (() => {
      const box = request.origin?.getBoundingClientRect();
      return box ? { x: box.right - 12, y: box.bottom } : { x: 0, y: 0 };
    })();

  return {
    // Right and bottom edges are clamped in CSS with `max-width`/`max-height`;
    // this only keeps the corner itself on screen.
    left: `${Math.max(MENU_MARGIN_PX, point.x)}px`,
    top: `${Math.max(MENU_MARGIN_PX, point.y)}px`,
  };
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 300) || 'The comparison could not be built.';
}

/**
 * A shortcut binding, as this view wants it: never while the reader is typing
 * into one of the view's own controls, and always claiming the key.
 *
 * `whileTyping` is on at the registry so a bare `n` still reaches us from the
 * scroll container, which is focusable; the field check is restated here because
 * the comparison has no text fields of its own but the document might.
 */
function press(run: () => void) {
  return (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    run();
  };
}

/** Whether a keystroke belongs to whatever the reader is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase());
}

/** Last path segment, for naming the document on screen in the header. */
function documentName(rawUrl: string): string {
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] ?? '') || 'this document';
  } catch {
    return 'this document';
  }
}

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
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
      {children}
    </svg>
  );
}

function SwapIcon() {
  return (
    <Frame>
      <path d="M2.5 5.5h11L10.6 2.6M13.5 10.5h-11l2.9 2.9" />
    </Frame>
  );
}

function ArrowIcon({ up = false }: { up?: boolean }) {
  return (
    <Frame>
      <path d={up ? 'M8 12.5V3.5M4.4 7.1 8 3.5l3.6 3.6' : 'M8 3.5v9M4.4 8.9 8 12.5l3.6-3.6'} />
    </Frame>
  );
}

function CloseIcon() {
  return (
    <Frame>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Frame>
  );
}
