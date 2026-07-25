/**
 * Message contract between the popup and the service worker.
 *
 * The split follows what each context is allowed to do: `permissions.request()`
 * needs a user gesture so it must run in the popup, while script registration
 * needs to survive the popup closing so it runs in the service worker.
 */

export type Message =
  /** Inject the renderer into a tab right now, using the activeTab grant. */
  | { type: 'RENDER_TAB'; tabId: number }
  /** Re-derive registered content scripts from currently granted permissions. */
  | { type: 'SYNC_REGISTRATIONS' };

export interface RenderTabResult {
  ok: boolean;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  /** Number of match patterns registered for automatic rendering. */
  patterns: number;
  error?: string;
}

export function sendMessage<T>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/**
 * Build output paths, injected via chrome.scripting. These are the *emitted*
 * filenames, not the source ones: WXT puts CSS entrypoints under `assets/`
 * while scripts land at the root. `scripts/check-build.mjs` asserts both exist
 * in the built extension, because a wrong path here fails only at runtime.
 */
export const RENDERER_JS = 'renderer.js';
export const RENDERER_CSS = 'assets/viewer.css';
