/**
 * The last viewer session's plugin failures, mirrored into storage.
 *
 * `PluginHost.statuses()` knows why a plugin was disabled, but that knowledge
 * lives in the host's memory, in the tab that rendered the document. The
 * options page is a different document with no host, so without this it could
 * only ever show a feature as "on" while the reader watched it do nothing.
 *
 * Deliberately not part of the plugin API: nothing a plugin can see, and
 * nothing the host depends on. The renderer publishes; the options page reads.
 * The record is replaced wholesale on every render, so it always describes the
 * most recent session rather than accumulating stale entries from old tabs.
 */

import type { PluginHost } from './plugins/host.ts';

export const PLUGIN_FAILURES_KEY = 'pluginFailures';

/** Plugin id to the host's `phase: message`, for plugins that threw. */
export type PluginFailures = Readonly<Record<string, string>>;

function collect(host: PluginHost): PluginFailures {
  const failures: Record<string, string> = {};
  for (const status of host.statuses()) {
    if (status.failure) failures[status.id] = status.failure;
  }
  return failures;
}

export async function readPluginFailures(): Promise<PluginFailures> {
  try {
    const stored = await chrome.storage.local.get(PLUGIN_FAILURES_KEY);
    const raw = stored[PLUGIN_FAILURES_KEY];
    if (typeof raw !== 'object' || raw === null) return {};

    // Storage is untrusted even though it is ours; a non-string value here
    // would be rendered straight into the page as a reason.
    const failures: Record<string, string> = {};
    for (const [id, message] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof message === 'string') failures[id] = message;
    }
    return failures;
  } catch {
    return {};
  }
}

/**
 * Keep storage in step with the host for the life of the document.
 *
 * Subscribed to `host.status` rather than written once after `start()`: a
 * plugin can also fail later, when a contribution throws while rendering or
 * when the reader enables it by hand.
 */
export function mirrorPluginFailures(host: PluginHost): () => void {
  let last = '';

  const publish = () => {
    const failures = collect(host);
    const next = JSON.stringify(failures);
    // Every enable and disable bumps the status store; only a change in the
    // failures themselves is worth a write.
    if (next === last) return;
    last = next;

    // A lost write costs a diagnostic, never the document.
    void chrome.storage.local
      .set({ [PLUGIN_FAILURES_KEY]: failures })
      .catch(() => undefined);
  };

  publish();
  return host.status.subscribe(publish);
}
