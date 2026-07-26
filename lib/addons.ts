/**
 * Asking for an add-on that renders into the document.
 *
 * Two add-ons — KaTeX and mermaid — are not called, they are *installed*: each
 * one finds its own placeholders in the body, renders them, and then watches
 * for more with a `MutationObserver` of its own. Nothing ever holds a reference
 * to them, so unlike export and diff they need no bridge and no ready check.
 * What they need is for someone to notice the document contains their syntax
 * and ask the service worker to inject them — which is what this is.
 *
 * Requested once per document *type of need*, not once per placeholder: the
 * plugins that call this run inside an enhancement pass that re-runs on every
 * render, every live reload and every raw toggle, and injecting mermaid four
 * times would evaluate 3.3MB four times. The promise is cached rather than a
 * boolean so that two passes in the same frame make one request between them.
 *
 * A failure is logged and forgotten deliberately. The document already renders
 * without the add-on — a formula reads as its own TeX, a diagram as its own
 * source — and the alternative, a modal about an injection the reader did not
 * ask for, is worse than the degradation. The cache is cleared on failure so a
 * later pass can try again; a service worker that was asleep is the most likely
 * cause and it will be awake next time.
 */

import type { AddonName } from './config.ts';
import { sendMessage, type AddonResult } from './messages.ts';

const requested = new Map<AddonName, Promise<boolean>>();

export function requestAddon(addon: AddonName): Promise<boolean> {
  const inFlight = requested.get(addon);
  if (inFlight) return inFlight;

  const attempt = sendMessage<AddonResult>({ type: 'INJECT_ADDON', addon })
    .then((result) => {
      if (result?.ok) return true;
      throw new Error(result?.error ?? 'the add-on could not be injected');
    })
    .catch((error: unknown) => {
      requested.delete(addon);
      console.warn(`[markdown-viewer] ${addon} add-on unavailable:`, error);
      return false;
    });

  requested.set(addon, attempt);
  return attempt;
}

/** Test seam. The map is module state, and a test that injects must reset it. */
export function resetRequestedAddons(): void {
  requested.clear();
}
