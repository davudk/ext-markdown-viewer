/**
 * Export, as a plugin.
 *
 * The menu used to be a component the shell mounted and handed typography to,
 * and the export itself lived inside it — which is why the command palette could
 * not offer "Export as HTML" at all: the ability was React state two components
 * away, and `Viewer.tsx` had no handler to pass down.
 *
 * So the split here is not cosmetic. Everything that *does* the export — the
 * add-on injection, the run, the progress, the outcome message and its timer —
 * lives in this file as a controller, and the controller is published as the
 * `export` capability. The menu is one view of it. The palette is another. A
 * third caller would need nothing new.
 *
 * That also makes the whole feature testable: `node --experimental-strip-types`
 * refuses a `.tsx` file outright, so anything the bare test runner has to reach
 * has to live outside JSX. The lifecycle is here for exactly that reason, the
 * same seam `plugins/presentation` uses.
 */

// Types only, all of them. A value import from `lib/export.ts` would pull
// `docx` — some 400 kB of OOXML writer — into the renderer for every document
// that is merely read, which is the entire reason the export is an add-on.
import type { ExportBridge } from '../../entrypoints/export-addon.ts';
import {
  EXPORT_BRIDGE_KEY,
  EXPORT_FORMATS,
  VIEWER_THEME_DATASET_KEY,
  type ExportFormat,
} from '../../lib/config.ts';
import type { ExportProgress, ExportTypography } from '../../lib/export.ts';
import { sendMessage, type AddonResult } from '../../lib/messages.ts';
import { Store } from '../../lib/plugins/registry.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { loadSettings, onSettingsChanged, type Settings } from '../../lib/settings.ts';

import type { ComponentType } from 'react';

export const EXPORT_PLUGIN_ID = 'export';

/** How long a completed message stays before the menu goes quiet again. */
const RESULT_MS = 6000;

/** What the reader is being told about the export in flight, if any. */
export type ExportStatus =
  | { state: 'idle' }
  | { state: 'busy'; progress: ExportProgress | null }
  | { state: 'done'; message: string }
  | { state: 'failed'; message: string };

const IDLE: ExportStatus = { state: 'idle' };

/**
 * What the `export` capability is.
 *
 * `formats` is what can be produced *right now* — a caller building a menu row
 * per format needs the list before it knows whether the add-on will load, and
 * an empty list is the honest way to say "not here" rather than a row that
 * fails after the reader has committed to it.
 *
 * `status` is a `Store` rather than a value because it changes while the plugin
 * stays enabled, and a capability's identity only changes when it is provided or
 * withdrawn — the same reason `files.status` is one.
 */
export interface ExportCapability {
  readonly formats: readonly ExportFormat[];
  readonly status: Store<ExportStatus>;
  run(format: ExportFormat): Promise<void>;
}

declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    export: ExportCapability;
  }
}

interface BridgeHost {
  [EXPORT_BRIDGE_KEY]?: ExportBridge;
}

/**
 * The export machinery, injected the first time it is wanted.
 *
 * `entrypoints/export-addon.ts` publishes a function on the isolated world's
 * `window` — the same world this runs in — and the service worker is asked to
 * put it there. Every way this can go wrong ends in a thrown error the caller
 * reports: the message failing, the injection being refused, or the property
 * still being absent afterwards. None of them ends in waiting.
 */
async function exportBridge(): Promise<ExportBridge> {
  const host = window as BridgeHost;
  // Already injected — by an earlier export in this document, or by one in a
  // document the reader has since navigated away from within the same page.
  const installed = host[EXPORT_BRIDGE_KEY];
  if (installed) return installed;

  const result = await sendMessage<AddonResult>({ type: 'INJECT_ADDON', addon: 'export' });
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

export interface ExportViews {
  /** The trigger and its menu. Rendered by the host into a chrome corner. */
  Menu: ComponentType;
}

export function createExportPlugin(views: ExportViews): Plugin {
  return {
    id: EXPORT_PLUGIN_ID,
    name: 'Export',
    description: 'Saves the document as a self-contained HTML or Word file.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,

    ui: [
      {
        // The same slot the shell used to render `<ExportMenu>` into, named for
        // where it is rather than for what fills it.
        region: 'chrome.top-end',
        key: 'menu',
        component: views.Menu,
      },
    ],

    setup(ctx) {
      const status = new Store<ExportStatus>(IDLE);

      /** The reader's typography, so the exported HTML matches their screen. */
      let typography: ExportTypography | null = null;
      let alive = true;
      const takeSettings = (settings: Settings) => {
        typography = {
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize,
          lineHeight: settings.lineHeight,
          contentWidth: settings.contentWidth,
        };
      };
      void loadSettings().then((settings) => {
        if (alive) takeSettings(settings);
      });
      const stopSettings = onSettingsChanged(takeSettings);

      let resultTimer = 0;
      /** Shows an outcome, then goes quiet so an identical one still announces. */
      const settle = (next: ExportStatus) => {
        status.set(next);
        clearTimeout(resultTimer);
        resultTimer = window.setTimeout(() => status.set(IDLE), RESULT_MS);
      };

      const capability: ExportCapability = {
        // Every format the build knows how to write. Whether the add-on arrives
        // is discovered on the first run and reported there — asking now would
        // mean injecting 400 kB to populate a menu nobody has opened.
        formats: EXPORT_FORMATS.map((format) => format.value),
        status,

        async run(format) {
          // The *rendered* element rather than the markdown: the images the
          // export embeds are the ones already decoded on screen.
          const body = ctx.document.body;
          if (!body) {
            settle({
              state: 'failed',
              message: 'Nothing to export — the document is not rendered.',
            });
            return;
          }

          status.set({ state: 'busy', progress: null });

          try {
            // Injected on first use rather than at setup: unlike mermaid,
            // nothing in a document says whether it will ever be exported.
            const runExport = await exportBridge();

            const result = await runExport({
              format,
              body,
              theme: document.documentElement.dataset[VIEWER_THEME_DATASET_KEY],
              typography: typography ?? undefined,
              url: ctx.document.url,
              onProgress: (progress) => status.set({ state: 'busy', progress }),
            });

            settle({
              state: 'done',
              message:
                result.skippedImages > 0
                  ? `Exported ${result.filename} — ${countImages(result.skippedImages)} could not be embedded.`
                  : `Exported ${result.filename}.`,
            });
          } catch (error) {
            settle({ state: 'failed', message: `Export failed: ${describe(error)}` });
          }
        },
      };

      ctx.capabilities.provide('export', capability);

      // No commands are registered here, deliberately. The palette already owns
      // the wording of "Export as HTML" and "Export as Word" — they are entries
      // in `PALETTE_COMMANDS` with keywords tuned for the matcher — and it builds
      // those two rows the moment this capability appears. Registering them here
      // as well would put the same action in the list twice under two names.

      return () => {
        alive = false;
        stopSettings();
        // The timer outlives the plugin otherwise, and would fire a `set` on a
        // store nothing is reading — harmless, but exactly the kind of residue
        // the toggle test exists to catch.
        clearTimeout(resultTimer);
        status.set(IDLE);
      };
    },
  };
}

function countImages(count: number): string {
  return count === 1 ? '1 image' : `${count} images`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // A stack-length message in a toast helps nobody; the console still has it.
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}
