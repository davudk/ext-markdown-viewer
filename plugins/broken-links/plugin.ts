/**
 * Marks links that lead nowhere.
 *
 * Two tiers, and they are not the same kind of claim:
 *
 *   **Tier 1 — anchors.** `#heading` links, checked against the ids
 *   `lib/markdown.ts` actually assigned. Free, needs no permission, no handle
 *   and no I/O, so it runs wherever the plugin is enabled.
 *
 *   **Tier 2 — relative files.** `./docs/foo.md`, `../README.md` and the
 *   relative hrefs wikilinks compile to, checked against the folder the reader
 *   opened. Needs the `files.browser` capability. **Absent is normal**: no
 *   folder open means tier 2 does not run — no error, no marks, nothing said.
 *
 * External `http(s)` links are never checked, at either tier. See the header of
 * `detect.ts`; there is no `fetch` in this plugin and there must never be one.
 *
 * # Tier 2 under a synchronous pass
 *
 * `ctx.document.enhance(pass)` is synchronous and returns one teardown, but the
 * folder tree fills in over time — the files tab mounts after the first paint,
 * and each directory the reader expands adds to what is known. Tier 2's answer
 * therefore arrives *after* the pass has already returned.
 *
 * Rather than making the pass async (it cannot be) or firing and forgetting a
 * promise (which is how a teardown ends up racing a mark that lands after it),
 * each run of the pass owns a small `Marks` ledger:
 *
 *   - the pass applies tier 1 immediately and returns its teardown at once, so
 *     the synchronous contract is met with the synchronous half of the answer;
 *   - tier 2 subscribes to the folder store and re-evaluates *both* tiers into
 *     the same ledger whenever the folder changes;
 *   - the ledger is the single record of what was written, so the teardown
 *     removes exactly what is on the document at that instant, whether the late
 *     result had landed or not;
 *   - the teardown also flips `cancelled` and unsubscribes before clearing, so
 *     a late arrival cannot reapply anything behind it. That ordering is the
 *     whole trick: no half-applied pass, in either direction.
 *
 * Split from `index.tsx` because `node --experimental-strip-types` refuses a
 * `.tsx` outright, and a plugin naming its component directly is a plugin no
 * unit test can load.
 */

import type { ComponentType } from 'react';

import { folderDocumentPath } from '../../lib/folder.ts';
import { Store } from '../../lib/plugins/registry.ts';
import {
  PLUGIN_API_VERSION,
  type Plugin,
  type PluginContext,
  type Teardown,
} from '../../lib/plugins/types.ts';

import {
  BROKEN_LINK_ATTRIBUTE,
  findBrokenAnchors,
  findBrokenRelativeLinks,
  parentOf,
  type BrokenLink,
  type FolderKnowledge,
} from './detect.ts';

export const BROKEN_LINKS_PLUGIN_ID = 'broken-links';

/**
 * Where the count lands.
 *
 * `reading-status` publishes no region of its own — it contributes a single
 * fixed layer to `document.after` and owns nothing another plugin could fill —
 * so there is no "status bar" to join. The count goes to the core region
 * `chrome.bottom-start` instead, which is empty, is named for the corner rather
 * than for its contents, and is the opposite corner from the reading chip and
 * the presentation launcher.
 */
export const BROKEN_LINKS_REGION = 'chrome.bottom-start';

export const BROKEN_LINKS_OVERLAY = 'broken-links';

/**
 * What the count and the list read.
 *
 * At module scope for the reason the presentation launcher reaches its deck
 * through a command: a UI contribution is a plain component declared before any
 * context exists, so it has no channel to the closure in `setup` that computed
 * this. The plugin is a singleton, `setup` resets the store on both edges, and
 * nothing outside this folder touches it.
 */
export const brokenLinks = new Store<readonly BrokenLink[]>([]);

const settings = {
  checkRelativeFiles: {
    type: 'boolean',
    default: true,
    label: 'Also check relative links against the open folder',
    description:
      'Only runs while a folder is open, and only for directories already listed. ' +
      'Links to other sites are never checked — that would mean a network request.',
  },
} as const;

export type BrokenLinksSettings = typeof settings;

export function createBrokenLinksPlugin(count: ComponentType): Plugin<BrokenLinksSettings> {
  return {
    id: BROKEN_LINKS_PLUGIN_ID,
    name: 'Broken links',
    description: 'Marks anchors and relative links that lead nowhere.',
    apiVersion: PLUGIN_API_VERSION,

    /**
     * Off by default. Every mark is an assertion about someone else's
     * document, and a reader who did not ask for that assertion should not
     * find their README underlined the first time they open it.
     *
     * There is deliberately no `enabled` *setting* beside this: whether the
     * feature runs is the plugin's enabled state and nothing else, so the two
     * halves cannot disagree. The settings page toggles it like every other
     * plugin, and `checkRelativeFiles` decides only whether tier 2 runs.
     */
    enabledByDefault: false,

    // Load order only. Tier 2 goes through the capability and handles its
    // absence, so this is a preference about who is ready first, not a need.
    after: ['files'],
    settings,

    ui: [{ region: BROKEN_LINKS_REGION, key: 'count', order: 40, component: count }],

    setup(ctx) {
      const stop = ctx.document.enhance((body) => {
        // The raw view is a single `<pre>` holding the markdown source. It has
        // no links, only text that looks like some.
        if (ctx.document.isRaw) return;

        const marks = new Marks();
        let cancelled = false;
        let unsubscribe: Teardown = () => {};

        const headingIds = new Set(ctx.document.headings.map((heading) => heading.id));

        /**
         * Both tiers, into one ledger. Re-entrant on purpose: the folder store
         * fires again on every directory the reader expands, and each run
         * replaces the previous marks wholesale rather than adding to them.
         */
        const evaluate = () => {
          if (cancelled) return;

          // No headings at all means the heading list is *unavailable* — the
          // markdown-headings plugin is off, or this document genuinely has
          // none. Either way there is nothing to validate against, and
          // validating against an empty set would mark every anchor in the
          // document. Unknown is not broken.
          const found =
            headingIds.size > 0
              ? findBrokenAnchors(body, ctx.document.url, headingIds)
              : [];

          const folder = ctx.settings.checkRelativeFiles ? knowledgeOf(ctx) : null;
          if (folder) {
            found.push(...findBrokenRelativeLinks(body, ctx.document.url, folder));
          }

          marks.apply(found);
          brokenLinks.set(found);
        };

        evaluate();

        if (ctx.settings.checkRelativeFiles) {
          // The late half. Subscribing rather than polling, and only while the
          // setting is on: with no folder ever opened this fires once at most
          // and changes nothing.
          const browser = ctx.capabilities.use('files.browser');
          if (browser) unsubscribe = browser.subscribe(evaluate);
        }

        return () => {
          // Order matters: refuse late work, detach from the source of it, then
          // undo. Clearing first would leave a subscription free to re-mark a
          // document this pass no longer owns.
          cancelled = true;
          unsubscribe();
          marks.clear();
          brokenLinks.set([]);
        };
      });

      // The host re-runs passes when the *document* changes; turning tier 2 off
      // has to re-run them against the same document.
      const resubscribe = ctx.onSettingsChange(() => ctx.document.refresh());

      return () => {
        resubscribe();
        stop();
        brokenLinks.set([]);
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The ledger                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Exactly what was written to the document, so exactly that can be taken back.
 *
 * Querying for `[data-mdv-broken]` at teardown time would remove whatever
 * carries the attribute *then*, which after a late tier-2 result is not the set
 * this pass wrote. The `title` is the sharper case: it is only ours when the
 * link had none, and restoring it by deleting the attribute unconditionally
 * would silently strip a title the author wrote.
 */
class Marks {
  private applied = new Map<HTMLAnchorElement, { ownsTitle: boolean }>();

  apply(links: readonly BrokenLink[]): void {
    const next = new Map<HTMLAnchorElement, { ownsTitle: boolean }>();

    for (const link of links) {
      const element = link.element;
      const existing = this.applied.get(element);
      // Reuse the previous record where there is one, so a re-evaluation
      // cannot convince itself it owns a title it merely wrote last time.
      const record = existing ?? { ownsTitle: !element.hasAttribute('title') };

      element.setAttribute(BROKEN_LINK_ATTRIBUTE, link.tier);
      if (record.ownsTitle) element.setAttribute('title', link.reason);
      next.set(element, record);
    }

    for (const [element, record] of this.applied) {
      if (!next.has(element)) this.remove(element, record);
    }
    this.applied = next;
  }

  clear(): void {
    for (const [element, record] of this.applied) this.remove(element, record);
    this.applied.clear();
  }

  private remove(element: HTMLAnchorElement, record: { ownsTitle: boolean }): void {
    element.removeAttribute(BROKEN_LINK_ATTRIBUTE);
    if (record.ownsTitle) element.removeAttribute('title');
  }
}

/* -------------------------------------------------------------------------- */
/* What tier 2 is allowed to know                                              */
/* -------------------------------------------------------------------------- */

/**
 * The open folder as far as it has been read, or null when tier 2 must not run.
 *
 * Null for every one of these, and none of them is an error:
 *
 *   - the files plugin is disabled, so the capability is absent;
 *   - no folder is open, so `rootName` is null;
 *   - the folder is open but this document did not come out of it, so there is
 *     no path to resolve relative links against.
 *
 * That last case is the honest limit of the published capability. A document
 * opened by real `file://` navigation *inside* the open folder has an address
 * the folder browser relates to the root itself (`resolveFileUrlBase`), but it
 * does not publish that base — so from out here the only documents whose path
 * is knowable are the ones opened through the handle, under `mdv-folder:`. The
 * alternative would be to guess, and a wrong base directory resolves every
 * relative link on the page to a file that is not there. Missing the case is
 * cheap; guessing it wrong marks the whole document.
 */
function knowledgeOf(ctx: PluginContext<BrokenLinksSettings>): FolderKnowledge | null {
  // Typed by declaration merging, with no import of the plugin that provides
  // it — which is the point of capabilities and the reason this file has no
  // dependency on `plugins/files/`.
  const browser = ctx.capabilities.use('files.browser');
  if (!browser) return null;

  const handle = browser.get();
  if (!handle.rootName || handle.files.length === 0) return null;

  const documentPath = folderDocumentPath(ctx.document.url, handle.rootName);
  if (documentPath === null) return null;

  const paths = new Set(handle.files.map((file) => file.id));
  // A directory is "read" exactly when a file in it is listed. The folder
  // browser publishes files, not directories, so this is the whole of what can
  // be known — and it is the conservative half: a directory holding only
  // sub-directories is never claimed to be understood.
  const directories = new Set([...paths].map(parentOf));

  return { documentPath, paths, directories };
}
