/**
 * jsdiff, and nothing else.
 *
 * Injected on demand by the service worker (`ADDONS` in lib/config.ts) the first
 * time a reader asks to compare two files, which for most readers is never. The
 * library is a couple of hundred kilobytes of Myers diff and patch handling, and
 * putting it in the renderer bundle would mean every .md file on the web paid
 * for a feature reached through a context menu.
 *
 * Unlike the mermaid and katex add-ons this one touches no DOM at all. It exists
 * only to hand three functions across the isolated world to `lib/diff.ts`, which
 * owns every decision made with them — so the deferred payload is the library
 * and not the feature, and the diff's own logic stays testable in node.
 *
 * A second injection re-runs the file with a fresh module scope, so "already
 * published" is recorded on the shared `window` rather than in a module flag.
 */

import { diffArrays, diffLines } from 'diff';

import {
  DIFF_BRIDGE_KEY,
  DIFF_READY_EVENT,
  VIEWER_ROOT_ID,
} from '@/lib/config';
import type { DiffChange, DiffEngine } from '@/lib/diff';

export default defineUnlistedScript(() => {
  // No viewer means nothing asked for this. The renderer is the only caller.
  if (!document.getElementById(VIEWER_ROOT_ID)) return;

  const world = globalThis as Record<string, unknown>;

  // Republishing would swap the engine out from under a comparison already
  // running against it — harmless today, since these are pure functions, but
  // the announcement below would also fire a second time and re-resolve a
  // waiter that has long since moved on.
  if (!world[DIFF_BRIDGE_KEY]) world[DIFF_BRIDGE_KEY] = engine();

  // After the assignment, so a listener woken by this always finds the bridge.
  window.dispatchEvent(new CustomEvent(DIFF_READY_EVENT));
});

/**
 * jsdiff's own `Change` and the `DiffChange` the renderer reads are the same
 * object; the wrapper exists so the renderer's contract is the narrow one it
 * declares rather than whatever this version of the library happens to return.
 */
function engine(): DiffEngine {
  return {
    lines: (before, after): DiffChange<string>[] =>
      // Newlines stay attached to their lines. `lib/diff.ts` splits the runs
      // itself, and it needs to be able to tell a file that ends in a newline
      // from one that does not.
      diffLines(before, after, { newlineIsToken: false }),

    blocks: (before, after): DiffChange<string[]>[] =>
      // The values are whole blocks of already-sanitized HTML, compared for
      // exact equality — jsdiff's default comparator, and the right one: two
      // paragraphs are the same paragraph or they are not.
      diffArrays(before, after),
  };
}
