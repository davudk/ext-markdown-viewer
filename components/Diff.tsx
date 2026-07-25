import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  DEFAULT_DIFF_LAYOUT,
  DEFAULT_DIFF_MODE,
  DIFF_LAYOUT_OPTIONS,
  DIFF_MODE_OPTIONS,
  VIEWER_ROOT_ID,
  type DiffLayout,
  type DiffMode,
} from '@/lib/config';
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
} from '@/lib/diff';
import { renderMarkdown } from '@/lib/markdown';

import './diff.css';

const FOCUSABLE =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Distance the menu is kept from the edge of the viewport. */
const MENU_MARGIN_PX = 8;

/** What the reader is currently looking at. */
type Phase = 'menu' | 'loading' | 'ready' | 'error';

interface Side {
  name: string;
  source: string;
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
export function Diff({
  request,
  currentName,
  currentSource,
  onClose,
}: {
  /** The row menu the folder tree raised, or null when there is nothing to do. */
  request: CompareRequest | null;
  /** Name of the document on screen. Shown as one side of the header. */
  currentName: string;
  /** Its markdown source — the other half of every comparison. */
  currentSource: string;
  /**
   * Clears `request`. Called both when the menu is dismissed without a choice
   * and when the comparison itself is closed, so the owner needs one handler.
   */
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('menu');
  const [engine, setEngine] = useState<DiffEngine | null>(null);
  const [other, setOther] = useState<Side | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<DiffMode>(DEFAULT_DIFF_MODE);
  const [layout, setLayout] = useState<DiffLayout>(DEFAULT_DIFF_LAYOUT);
  const [swapped, setSwapped] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const dialogRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);

  const titleId = useId();

  // Every new request starts from nothing: a comparison left open in the
  // background would otherwise reappear against the wrong file.
  useEffect(() => {
    setPhase('menu');
    setEngine(null);
    setOther(null);
    setError(null);
    setSwapped(false);
    setCursor(0);
    setExpanded(new Set());
  }, [request]);

  const dismiss = useCallback(() => {
    // Focus first, then unmount: `request.origin` is a row in the sidebar and
    // is still in the document either way, but restoring before the overlay
    // goes away avoids a frame with focus on <body>.
    request?.origin?.focus({ preventScroll: true });
    onClose();
  }, [request, onClose]);

  /* ------------------------------------------------------------------------ */
  /* Starting the comparison                                                   */
  /* ------------------------------------------------------------------------ */

  const start = useCallback(async () => {
    if (!request) return;

    setPhase('loading');
    setError(null);

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
  /* Modal behaviour                                                           */
  /* ------------------------------------------------------------------------ */

  const isOverlay = request !== null && phase !== 'menu';

  useEffect(() => {
    if (!isOverlay) return;

    const root = document.getElementById(VIEWER_ROOT_ID);
    const html = document.documentElement;
    const previousOverflow = html.style.overflow;

    html.style.overflow = 'hidden';
    // One flag for both halves of "modal": the document leaves the tab order
    // and disappears from the accessibility tree.
    root?.setAttribute('inert', '');
    closeRef.current?.focus();

    // The backstop under the Tab trap: focus can also arrive from outside the
    // dialog, cycling back in from the browser's own chrome.
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      closeRef.current?.focus();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      document.removeEventListener('focusin', onFocusIn);
      html.style.overflow = previousOverflow;
      // Before any focus call: focus() inside an inert subtree does nothing.
      root?.removeAttribute('inert');
    };
  }, [isOverlay]);

  /** The menu is a popup, not a modal: focus moves in, but the page stays live. */
  useEffect(() => {
    if (request === null || phase !== 'menu') return;

    itemRef.current?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      dismiss();
    };
    // A menu that survives the page scrolling out from under it is a menu
    // floating over the wrong row.
    const onScroll = () => dismiss();

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [request, phase, dismiss]);

  /* ------------------------------------------------------------------------ */
  /* Keys                                                                      */
  /* ------------------------------------------------------------------------ */

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The viewer's unmodified shortcuts (t, r, d, /) listen on window, and every
    // one of them would otherwise fire straight through this.
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }

    if (event.key === 'Tab' && isOverlay) {
      trapFocus(event, dialogRef.current);
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey || !isOverlay) return;

    switch (event.key) {
      case 'n':
      case 'j':
        goto(cursor + 1);
        break;
      case 'p':
      case 'k':
        goto(cursor - 1);
        break;
      case 's':
        setSwapped((value) => !value);
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  /* ------------------------------------------------------------------------ */

  if (!request) return null;

  if (phase === 'menu') {
    return createPortal(
      <div
        ref={menuRef}
        className="mdv-diff-menu"
        data-mdv-chrome
        role="menu"
        aria-label={`Actions for ${request.name}`}
        style={menuPosition(request)}
        onKeyDown={onKeyDown}
      >
        <button
          ref={itemRef}
          type="button"
          className="mdv-diff-menu-item"
          role="menuitem"
          title={request.path}
          onClick={() => void start()}
        >
          Compare with current file
        </button>
      </div>,
      document.body,
    );
  }

  const failed = comparison?.failed ?? null;
  const stats: DiffStats | null = comparison?.stats ?? null;

  return createPortal(
    <div
      className="mdv-diff"
      // Read by the print rule below, which strips chrome by attribute rather
      // than by class name the way viewer.css does inside the shell.
      data-mdv-chrome
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        className="mdv-diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
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
              ref={closeRef}
              type="button"
              className="mdv-diff-tool"
              aria-label="Close comparison"
              title="Close (Esc)"
              onClick={dismiss}
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
    </div>,
    document.body,
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

function trapFocus(
  event: ReactKeyboardEvent<HTMLDivElement>,
  dialog: HTMLElement | null,
) {
  if (!dialog) return;

  const nodes = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // Rendered, rather than merely present: a control the current state hides
    // is not somewhere Tab may land.
    (node) => node.getClientRects().length > 0,
  );
  if (nodes.length === 0) return;

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;

  if (event.shiftKey ? active === first : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
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
