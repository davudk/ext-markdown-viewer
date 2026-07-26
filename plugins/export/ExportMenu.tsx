import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';

import { EXPORT_FORMATS, type ExportFormat } from '../../lib/config.ts';
import type { ExportProgress } from '../../lib/export.ts';
import { useDocument, usePlugin, usePluginHost } from '../../lib/plugins/react.tsx';

import type { ExportStatus } from './plugin.ts';
import './export-menu.css';

const IDLE: ExportStatus = { state: 'idle' };
const noopSubscribe = () => () => {};

/**
 * The export menu: one entry per format, plus the progress and outcome of the
 * export in flight.
 *
 * This is now only the view. The add-on injection, the run and the reporting
 * moved into `plugin.ts` and are published as the `export` capability, which is
 * what lets the command palette offer the same two actions without this
 * component being on screen — or mounted at all.
 *
 * What is left is the button, the menu keyboard model, and an honest report. A
 * document with cross-origin images cannot be fully embedded without a network
 * request, so a perfectly ordinary export can succeed *partially*. Saying so
 * ("exported, 3 images could not be embedded") is the difference between a
 * reader who knows to check the file and one who finds out later.
 *
 * Deliberately not an overlay. `ctx.ui.openOverlay` is for modal surfaces — it
 * inerts the document beneath and traps focus, which is exactly wrong for a menu
 * button whose whole contract is that Tab leaves it. This stays an absolutely
 * positioned popup anchored under its own trigger, inside its own stacking
 * context, and picks no new number to do it.
 */
export function ExportMenu() {
  const ctx = usePlugin();
  const host = usePluginHost();
  const doc = useDocument();

  // The controller is this plugin's own, but it is read through the registry
  // rather than closed over: a contribution is declared before any context
  // exists, and the store is what tells React when it appeared.
  useSyncExternalStore(host.capabilities.store.subscribe, () =>
    host.capabilities.store.get(),
  );
  const exporter = ctx.capabilities.use('export');

  const status = useSyncExternalStore(
    exporter?.status.subscribe ?? noopSubscribe,
    () => exporter?.status.get() ?? IDLE,
  );

  const [open, setOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

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

  const run = useCallback(
    (format: ExportFormat) => {
      close(true);
      void exporter?.run(format);
    },
    [close, exporter],
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

  // The raw view has no rendered document to export. The shell used to say this
  // with `showRaw ? null :` at the mount site; the shared document answers it
  // here now, and the capability stays available either way — a palette row that
  // exports the rendered document is still the right thing to offer.
  if (doc.isRaw || !exporter) return null;

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
              onClick={() => run(format.value)}
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

/** Inline, because the extension never loads a resource of any kind. */
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
