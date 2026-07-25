import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import type { ExportBridge } from '@/entrypoints/export-addon';
import {
  EXPORT_BRIDGE_KEY,
  EXPORT_FORMATS,
  VIEWER_THEME_DATASET_KEY,
  type ExportFormat,
} from '@/lib/config';
// Types only, all of them. A value import from `lib/export.ts` would pull
// `docx` — some 400 kB of OOXML writer — into the renderer for every document
// that is merely read, which is the entire reason the export is an add-on.
import type { ExportProgress, ExportTypography } from '@/lib/export';
import { sendMessage, type AddonResult } from '@/lib/messages';

import './export-menu.css';

/** How long a completed message stays before the menu goes quiet again. */
const RESULT_MS = 6000;

/** Where the document lives when the caller does not say. */
const DEFAULT_BODY_SELECTOR = '.mdv-body';

interface BridgeHost {
  [EXPORT_BRIDGE_KEY]?: ExportBridge;
}

/**
 * The export machinery, injected the first time it is wanted.
 *
 * `entrypoints/export-addon.ts` publishes a function on the isolated world's
 * `window` — the same world this component runs in — and the service worker is
 * asked to put it there. Every way this can go wrong ends in a thrown error the
 * caller reports: the message failing, the injection being refused, or the
 * property still being absent afterwards. None of them ends in waiting.
 */
async function exportBridge(): Promise<ExportBridge> {
  const host = window as BridgeHost;
  // Already injected — by an earlier export in this document, or by one in a
  // document the reader has since navigated away from within the same page.
  const installed = host[EXPORT_BRIDGE_KEY];
  if (installed) return installed;

  const result = await sendMessage<AddonResult>({
    type: 'INJECT_ADDON',
    addon: 'export',
  });
  if (!result?.ok) {
    throw new Error(result?.error ?? 'the export add-on could not be injected');
  }

  const bridge = host[EXPORT_BRIDGE_KEY];
  // `executeScript` has resolved, so the script has finished running. Nothing
  // here means it declined — no viewer on the page — rather than that it is
  // still on its way.
  if (!bridge) throw new Error('the export add-on did not install');

  return bridge;
}

export interface ExportMenuProps {
  /**
   * Resolves the live rendered document. Defaults to the `.mdv-body` in the
   * page — the export needs the *rendered* element rather than the markdown,
   * because the images it embeds are the ones already decoded there.
   */
  getBody?: () => Element | null;
  /** Resolved theme. Defaults to whatever `data-mdv-theme` says on <html>. */
  theme?: string;
  /** The reader's typography, so the exported HTML matches their screen. */
  typography?: ExportTypography;
  /** The document's own address. Defaults to `location.href`. */
  url?: string;
}

type Status =
  | { state: 'idle' }
  | { state: 'busy'; progress: ExportProgress | null }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string };

/**
 * The export menu: one entry per format in `EXPORT_FORMATS`, plus the progress
 * and outcome of the export in flight.
 *
 * Everything real happens in `entrypoints/export-addon.ts`, which is asked for
 * on the first click and reached through `exportBridge` below; this is the
 * button, the menu keyboard model, and — the part worth the code — an honest
 * report. That includes the add-on failing to arrive, which surfaces in the
 * same assertive live region as any other export failure. A document
 * with cross-origin images cannot be fully embedded without a network request,
 * so a perfectly ordinary export can succeed *partially*. Saying so ("exported,
 * 3 images could not be embedded") is the difference between a reader who knows
 * to check the file and one who finds out later.
 *
 * The root carries `data-mdv-chrome`, which is what keeps it off the printed
 * page and out of the export it produces.
 */
export function ExportMenu({
  getBody,
  theme,
  typography,
  url,
}: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const resultTimer = useRef(0);

  const menuId = useId();
  const busy = status.state === 'busy';

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // Pointer and focus leaving the menu both mean "not using it any more". A
  // capture-phase listener sees the click even when it lands on a document
  // element that stops propagation.
  useEffect(() => {
    if (!open) return;

    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss, true);

    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss, true);
    };
  }, [open]);

  // Opening with the keyboard has to land somewhere; the first item is where a
  // menu button is expected to put you.
  useEffect(() => {
    if (open) itemsRef.current[0]?.focus();
  }, [open]);

  useEffect(() => () => clearTimeout(resultTimer.current), []);

  const settle = useCallback((next: Status) => {
    setStatus(next);
    clearTimeout(resultTimer.current);
    resultTimer.current = window.setTimeout(() => {
      // Back to idle so an identical message next time still reads as a change,
      // which is the only way a live region announces it twice.
      setStatus({ state: 'idle' });
    }, RESULT_MS);
  }, []);

  const run = useCallback(
    async (format: ExportFormat) => {
      close(true);

      const body = getBody ? getBody() : document.querySelector(DEFAULT_BODY_SELECTOR);
      if (!body) {
        settle({ state: 'failed', message: 'Nothing to export — the document is not rendered.' });
        return;
      }

      setStatus({ state: 'busy', progress: null });

      try {
        // Injected on first use rather than at render time: unlike mermaid,
        // nothing in a document says whether it will ever be exported.
        const runExport = await exportBridge();

        const result = await runExport({
          format,
          body,
          theme: theme ?? document.documentElement.dataset[VIEWER_THEME_DATASET_KEY],
          typography,
          url,
          onProgress: (progress) => setStatus({ state: 'busy', progress }),
        });

        settle({
          state: 'done',
          message:
            result.skippedImages > 0
              ? `Exported ${result.filename} — ${countImages(result.skippedImages)} could not be embedded.`
              : `Exported ${result.filename}.`,
        });
      } catch (error) {
        settle({
          state: 'failed',
          message: `Export failed: ${describe(error)}`,
        });
      }
    },
    [close, getBody, settle, theme, typography, url],
  );

  /** Arrow-key roving focus, which is what makes this a menu and not a popup. */
  const onMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const items = itemsRef.current.filter((item): item is HTMLButtonElement => item !== null);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);

      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          close(true);
          return;
        case 'ArrowDown':
          event.preventDefault();
          items[(index + 1) % items.length]?.focus();
          return;
        case 'ArrowUp':
          event.preventDefault();
          items[(index - 1 + items.length) % items.length]?.focus();
          return;
        case 'Home':
          event.preventDefault();
          items[0]?.focus();
          return;
        case 'End':
          event.preventDefault();
          items[items.length - 1]?.focus();
          return;
        case 'Tab':
          // Tab out closes rather than leaving an orphaned menu behind the
          // reader; focus is already on its way somewhere else.
          setOpen(false);
      }
    },
    [close],
  );

  return (
    <div className="mdv-export" ref={rootRef} data-mdv-chrome>
      <button
        type="button"
        ref={triggerRef}
        className="mdv-export-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={busy}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <DownloadIcon />
        {busy ? 'Exporting…' : 'Export'}
      </button>

      {open ? (
        <div
          id={menuId}
          className="mdv-export-menu"
          role="menu"
          aria-label="Export format"
          onKeyDown={onMenuKeyDown}
        >
          {EXPORT_FORMATS.map((format, index) => (
            <button
              key={format.value}
              type="button"
              role="menuitem"
              className="mdv-export-item"
              ref={(node) => {
                itemsRef.current[index] = node;
              }}
              onClick={() => void run(format.value)}
            >
              <span className="mdv-export-item-label">{format.label}</span>
              <span className="mdv-export-item-ext">{format.extension}</span>
            </button>
          ))}
        </div>
      ) : null}

      {busy ? <Progress progress={status.progress} /> : null}

      {/* Two regions, because the two messages are not equally urgent: a result
          can wait for a pause in speech, a failure cannot. Both are always in
          the tree — a live region added at the same moment as its text is
          frequently not announced at all. */}
      <div className="mdv-export-live" role="status" aria-live="polite">
        {status.state === 'done' ? status.message : ''}
      </div>
      <div className="mdv-export-live" role="alert" aria-live="assertive">
        {status.state === 'failed' ? status.message : ''}
      </div>

      {status.state === 'done' || status.state === 'failed' ? (
        <p
          className={
            status.state === 'failed'
              ? 'mdv-export-note mdv-export-note-failed'
              : 'mdv-export-note'
          }
          aria-hidden="true"
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Determinate while images are being serialized — the one stage whose length is
 * known and the one that actually takes time on a screenshot-heavy README.
 */
function Progress({ progress }: { progress: ExportProgress | null }) {
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const known = progress?.stage === 'images' && total > 0;

  return (
    <div className="mdv-export-progress">
      <div
        className="mdv-export-bar"
        role="progressbar"
        aria-label="Export progress"
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? total : undefined}
        aria-valuenow={known ? done : undefined}
      >
        <span
          className={known ? 'mdv-export-fill' : 'mdv-export-fill mdv-export-fill-busy'}
          style={known ? { width: `${Math.round((done / total) * 100)}%` } : undefined}
        />
      </div>
      <p className="mdv-export-note">
        {known ? `Embedding images — ${done} of ${total}` : 'Building the file…'}
      </p>
    </div>
  );
}

function countImages(count: number): string {
  return count === 1 ? '1 image' : `${count} images`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // A stack-length message in a toast helps nobody; the console still has it.
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

function DownloadIcon() {
  return (
    <svg
      className="mdv-export-icon"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2.4v7.2M5 6.8 8 9.8l3-3" />
      <path d="M2.6 11.4v1.2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-1.2" />
    </svg>
  );
}
