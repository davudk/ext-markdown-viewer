/**
 * Message contract between the popup, the options page, and the service worker.
 *
 * The split follows what each context is allowed to do: `permissions.request()`
 * needs a user gesture so it must run in a page, while script registration
 * needs to survive that page closing so it runs in the service worker.
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
