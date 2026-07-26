/**
 * Peek at what a link points to, without leaving the page.
 *
 * Footnote references, in-document anchors, relative file links and wikilinks
 * get a small panel after the pointer rests on them. Nothing else does, and in
 * particular no `http(s)` link does — previewing one would mean fetching it,
 * and this extension does not fetch. `preview.ts` states the rule where the
 * refusal is implemented; everything here is the wiring around it.
 *
 * Three things about the shape are deliberate:
 *
 * **One delegated listener per event, on the body.** A document of release
 * notes has hundreds of footnote references, and a listener on each is hundreds
 * of registrations to make and unmake every time the body is replaced. The body
 * is what the enhancement pass was handed, so listeners on it unbind with the
 * document they were registered for.
 *
 * **The timer is injected.** The 300ms delay is the feature — it is what keeps
 * a skim from strobing — so a test has to be able to assert that nothing
 * happens before it elapses, and that a pending one cannot fire after teardown.
 * With `Timers` as a parameter both are ordinary assertions rather than a race
 * against the wall clock.
 *
 * **The placement decision is separate from the placement.** Chrome's support
 * for CSS anchor positioning is uneven and the failure mode is a panel pinned
 * to a corner, which is worse than no panel. So the plugin asks the browser
 * once what it can do, and where anchor positioning is missing it computes
 * coordinates itself with `decidePlacement` — arithmetic, asserted without a
 * layout engine. Where the Popover API itself is missing (jsdom, and any engine
 * behind it) the panel is a plain absolutely-positioned element: less isolated
 * from the page's stacking, but visible and dismissible, which is the point.
 */

import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';
import { folderDocumentPath } from '../../lib/folder.ts';

import {
  CLAIMED,
  HOVER_DELAY_MS,
  cloneBlocks,
  decidePlacement,
  fragmentOf,
  previewBlocks,
  previewKind,
  resolveFolderPath,
  summarizeSource,
  type PreviewKind,
} from './preview.ts';

export const HOVER_PREVIEWS_PLUGIN_ID = 'hover-previews';

/** The panel, and the class every rule in `hover-previews.css` keys off. */
export const PREVIEW_CLASS = 'mdv-preview';

/** Anchor positioning needs a name on both ends; this is our end of it. */
const ANCHOR_NAME = '--mdv-preview-anchor';

/** Matches the `max-*` in the stylesheet, for the fallback's arithmetic. */
const MAX_WIDTH = 400;
const MAX_HEIGHT = 300;

const settings = {
  delay: {
    type: 'number',
    default: HOVER_DELAY_MS,
    min: 0,
    max: 2000,
    step: 50,
    unit: 'ms',
    label: 'Hover delay',
    description: 'How long to rest on a link before its preview appears.',
  },
} as const;

/**
 * The clock, as a parameter.
 *
 * `number` rather than `ReturnType<typeof setTimeout>` because the DOM and node
 * disagree about that type and this plugin only ever hands the handle back.
 */
export interface Timers {
  set(run: () => void, ms: number): number;
  clear(handle: number): void;
}

const REAL_TIMERS: Timers = {
  set: (run, ms) => setTimeout(run, ms) as unknown as number,
  clear: (handle) => clearTimeout(handle),
};

/** What the engine underneath will actually do for us. */
export interface Surface {
  popover: boolean;
  anchorPositioning: boolean;
}

/**
 * Asked once, at setup, rather than assumed.
 *
 * Both features are checked for directly — `showPopover` on an element and
 * `anchor-name` through `CSS.supports` — because the alternative is a version
 * check, and "Chrome 125" is not the same claim as "this engine will position
 * my panel".
 */
export function detectSurface(window: Window | null | undefined): Surface {
  // `CSS` is typed onto the global rather than onto `Window`, and this is
  // deliberately handed the view rather than reading a global — a test supplies
  // a jsdom window, and the plugin must ask the document it is enhancing.
  const view = window as (Window & { CSS?: { supports?(a: string, b: string): boolean } }) | null | undefined;
  if (!view?.document) return { popover: false, anchorPositioning: false };

  const probe = view.document.createElement('div');
  const popover =
    typeof (probe as { showPopover?: unknown }).showPopover === 'function' &&
    'popover' in probe;

  let anchorPositioning = false;
  try {
    anchorPositioning =
      popover &&
      typeof view.CSS?.supports === 'function' &&
      view.CSS.supports('anchor-name', ANCHOR_NAME) &&
      view.CSS.supports('position-area', 'block-end');
  } catch {
    // A `CSS.supports` that throws is an engine we are not going to trust with
    // the positioning either.
    anchorPositioning = false;
  }

  return { popover, anchorPositioning };
}

export function createHoverPreviewsPlugin(timers: Timers = REAL_TIMERS): Plugin<typeof settings> {
  return {
    id: HOVER_PREVIEWS_PLUGIN_ID,
    name: 'Link previews',
    description: 'Shows what a footnote, anchor or file link points at, on hover.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    // Load order only: the folder browser is read through a capability, and its
    // absence is the ordinary state in which cross-file previews are skipped.
    after: ['files'],
    settings,

    setup(ctx) {
      /**
       * Bumped by every hide and every new hover.
       *
       * The one guard that makes a stranded timer or a late `read()` inert:
       * both capture the generation they were started in, and do nothing if it
       * has moved on. `clear` is still called — this is the backstop, not the
       * mechanism — because a timer that is cancelled costs nothing and a
       * timer that fires into a torn-down plugin is exactly the residue the
       * architecture is built to prevent.
       */
      let generation = 0;
      let pending: number | null = null;
      let panel: HTMLElement | null = null;
      let anchor: HTMLAnchorElement | null = null;
      let detachDismissers: Teardown | null = null;
      let disposed = false;

      const surface = detectSurface(ctx.document.body?.ownerDocument?.defaultView);

      /* ------------------------------------------------------------------ */
      /* Showing and hiding                                                  */
      /* ------------------------------------------------------------------ */

      const hide = () => {
        generation += 1;

        if (pending !== null) {
          timers.clear(pending);
          pending = null;
        }

        detachDismissers?.();
        detachDismissers = null;

        if (anchor) {
          anchor.style.removeProperty('anchor-name');
          if (!anchor.getAttribute('style')) anchor.removeAttribute('style');
          anchor = null;
        }

        if (panel) {
          // `hidePopover` throws if the panel was never shown — which is the
          // case the moment anything above closed it first.
          try {
            (panel as { hidePopover?: () => void }).hidePopover?.();
          } catch {
            /* already hidden */
          }
          panel.remove();
          panel = null;
        }
      };

      const present = (link: HTMLAnchorElement, fill: (host: HTMLElement) => boolean) => {
        const owner = link.ownerDocument;
        const host = owner.createElement('div');
        host.className = PREVIEW_CLASS;
        // Chrome, not document: it is an aid on screen and has no business in
        // print, in the export, or in anything that reads the document's text.
        host.setAttribute('data-mdv-chrome', '');
        // A tooltip, not a dialog: supplementary, never focused, and never the
        // only route to what it shows — the link it describes still goes there.
        host.setAttribute('role', 'tooltip');
        host.setAttribute('aria-hidden', 'true');

        if (!fill(host)) return;

        if (surface.popover) host.setAttribute('popover', 'manual');

        owner.body.append(host);
        panel = host;
        anchor = link;

        if (surface.anchorPositioning) {
          link.style.setProperty('anchor-name', ANCHOR_NAME);
          host.style.setProperty('position-anchor', ANCHOR_NAME);
          // The browser flips the panel itself when the preferred side does not
          // fit, which is the whole reason to prefer this path.
          host.style.setProperty('position-area', 'block-end span-inline-end');
          host.style.setProperty('position-try-fallbacks', 'flip-block, flip-inline');
        } else {
          host.dataset.mdvFallback = '';
        }

        try {
          (host as { showPopover?: () => void }).showPopover?.();
        } catch {
          // Shown as an ordinary element instead; the stylesheet covers both.
        }

        if (!surface.anchorPositioning) placeManually(link, host);

        detachDismissers = attachDismissers(owner);
      };

      /**
       * The fallback's positioning: measure, decide, write.
       *
       * The decision is `decidePlacement` and lives in `preview.ts` with the
       * rest of the arithmetic. What is here is only the reading and the
       * writing, which is the part no test can assert without a layout.
       */
      const placeManually = (link: HTMLAnchorElement, host: HTMLElement) => {
        const view = link.ownerDocument.defaultView;
        if (typeof link.getBoundingClientRect !== 'function' || !view) return;

        const rect = link.getBoundingClientRect();
        const measured = host.getBoundingClientRect?.();

        const placement = decidePlacement(
          { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          {
            width: view.innerWidth || MAX_WIDTH,
            height: view.innerHeight || MAX_HEIGHT,
          },
          {
            width: Math.min(measured?.width || MAX_WIDTH, MAX_WIDTH),
            height: Math.min(measured?.height || MAX_HEIGHT, MAX_HEIGHT),
          },
        );

        host.style.position = 'fixed';
        host.style.left = `${Math.round(placement.left)}px`;
        host.style.top = `${Math.round(placement.top)}px`;
        host.dataset.mdvSide = placement.side;
      };

      /**
       * Escape, and the things that move the panel out from under itself.
       *
       * Registered on the owner document rather than on the body because a
       * keyboard reader who tabbed to the link may well have focus somewhere
       * this plugin does not own, and Escape has to work from there. They are
       * attached only while a panel is up, and removed with it.
       */
      const attachDismissers = (owner: Document): Teardown => {
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Escape') return;
          // Not `preventDefault`: Escape belongs to whatever else is listening
          // too, and a preview is not modal enough to swallow it.
          hide();
        };

        const view = owner.defaultView;
        owner.addEventListener('keydown', onKeyDown, true);
        view?.addEventListener('scroll', hide, true);
        view?.addEventListener('resize', hide);

        return () => {
          owner.removeEventListener('keydown', onKeyDown, true);
          view?.removeEventListener('scroll', hide, true);
          view?.removeEventListener('resize', hide);
        };
      };

      /* ------------------------------------------------------------------ */
      /* What each kind of link shows                                        */
      /* ------------------------------------------------------------------ */

      /** In this document: the live body already holds the answer, parsed. */
      const showFragment = (link: HTMLAnchorElement): void => {
        const body = ctx.document.body;
        const id = fragmentOf(link.getAttribute('href') ?? '');
        if (!body || !id) return;

        // Scanned rather than selected: a heading slug is whatever the document
        // put in it, and building a selector out of it means getting CSS
        // escaping right for text nobody validated. `[id]` is a cheap query and
        // this runs once per hover, not once per link.
        const target = [...body.querySelectorAll('[id]')].find(
          (element) => element.id === id,
        );
        // A link to an anchor that is not there shows nothing at all. An empty
        // panel would be a claim that the target exists and is blank.
        if (!target) return;

        present(link, (host) => {
          host.append(cloneBlocks(previewBlocks(target)));
          return host.textContent!.trim().length > 0;
        });
      };

      /**
       * In another file: only through a folder handle, and silently not at all
       * otherwise.
       *
       * A relative link in a document opened from `file://` or from a server
       * could only be resolved by requesting it, so the absence of the handle
       * is not a degraded state to report — it is the state in which this
       * feature has nothing to offer, which is exactly how every other
       * capability consumer treats an absent provider.
       */
      const showFile = async (link: HTMLAnchorElement, token: number): Promise<void> => {
        const browser = ctx.capabilities.use('files.browser')?.get();
        if (!browser?.rootName) return;

        const href = link.getAttribute('href') ?? '';
        const current = folderDocumentPath(ctx.document.url, browser.rootName);
        if (current === null) return;

        const path = resolveFolderPath(current, href);
        if (!path) return;

        const known = browser.files.some((file) => file.id === path);
        if (!known) return;

        let source: string;
        try {
          source = await browser.read(path);
        } catch {
          // The file moved or the permission lapsed. Nothing to say about it —
          // the link still works, and it is the link that will report it.
          return;
        }

        // The reader moved on, or the plugin was disabled, while the file was
        // being read. Either way this panel is about a hover that is over.
        if (disposed || token !== generation) return;

        const blocks = summarizeSource(source, fragmentOf(href));
        if (blocks.length === 0) return;

        present(link, (host) => {
          const owner = host.ownerDocument;
          const title = owner.createElement('p');
          title.className = `${PREVIEW_CLASS}-source`;
          title.textContent = path;
          host.append(title);

          for (const block of blocks) {
            const paragraph = owner.createElement('p');
            // `textContent`: the other file has not been through the renderer
            // or through DOMPurify, and a preview is not the place to start a
            // second sanitization story.
            paragraph.textContent = block;
            host.append(paragraph);
          }
          return true;
        });
      };

      /* ------------------------------------------------------------------ */
      /* The pass, and the delegated listeners                               */
      /* ------------------------------------------------------------------ */

      const schedule = (link: HTMLAnchorElement) => {
        hide();

        const token = generation;
        const delay = Math.max(0, ctx.settings.delay);

        pending = timers.set(() => {
          pending = null;
          // The guard, not the mechanism: `hide` has already cancelled this
          // handle in every ordinary path. It is what makes a timer that
          // somehow survives teardown do nothing at all.
          if (disposed || token !== generation) return;
          if (!link.isConnected) return;

          const kind = link.getAttribute(CLAIMED) as PreviewKind | null;
          if (kind === 'fragment') showFragment(link);
          else if (kind === 'file') void showFile(link, token);
        }, delay);
      };

      const stop = ctx.document.enhance((body) => {
        // The raw view is one `<pre>` of source text: no links, and nothing a
        // preview could be a preview of.
        if (ctx.document.isRaw) {
          hide();
          return;
        }

        const claimed = claimLinks(body, ctx.document.url);

        /**
         * One handler per event for the whole document. `mouseover` rather
         * than `mouseenter` because only the former bubbles — which is the
         * entire reason delegation is possible here.
         */
        const onOver = (event: Event) => {
          const link = claimedLinkAt(event.target);
          if (!link || link === anchor) return;
          schedule(link);
        };

        const onOut = (event: Event) => {
          const link = claimedLinkAt(event.target);
          if (!link) return;

          // Moving within the same link — across a `<code>` inside it, say —
          // is not leaving it.
          const to = (event as MouseEvent).relatedTarget;
          if (to instanceof Node && link.contains(to)) return;
          hide();
        };

        // Keyboard readers get the same thing on focus. `focusin`/`focusout`
        // bubble where `focus`/`blur` do not, so this is one listener too.
        const onFocusIn = (event: Event) => {
          const link = claimedLinkAt(event.target);
          if (link) schedule(link);
        };

        const onFocusOut = () => hide();

        body.addEventListener('mouseover', onOver);
        body.addEventListener('mouseout', onOut);
        body.addEventListener('focusin', onFocusIn);
        body.addEventListener('focusout', onFocusOut);

        return () => {
          body.removeEventListener('mouseover', onOver);
          body.removeEventListener('mouseout', onOut);
          body.removeEventListener('focusin', onFocusIn);
          body.removeEventListener('focusout', onFocusOut);
          // A panel left standing over a body that is being replaced would be
          // describing a document that no longer exists.
          hide();
          release(claimed);
        };
      });

      // The delay is a setting, and a setting whose pass has to be reapplied is
      // what `refresh` exists for — here it only re-marks, which is cheap and
      // keeps one path rather than two.
      const onSettings = ctx.onSettingsChange(() => hide());

      return () => {
        disposed = true;
        onSettings();
        // Ordered: `stop` runs the pass teardown, which hides; `hide` again is
        // the belt for the case where no pass ever ran.
        stop();
        hide();
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The document side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Marks every link a preview could be shown for, and reports which.
 *
 * The classification happens once per document here rather than once per hover,
 * so the delegated handlers are an attribute read. The `:not` keeps a re-run
 * proportional to what is new.
 */
export function claimLinks(body: HTMLElement, documentUrl: string): HTMLAnchorElement[] {
  const claimed: HTMLAnchorElement[] = [];

  body
    .querySelectorAll<HTMLAnchorElement>(`a[href]:not([${CLAIMED}])`)
    .forEach((link) => {
      const kind = previewKind(link.getAttribute('href') ?? '', documentUrl);
      if (!kind) return;

      link.setAttribute(CLAIMED, kind);
      claimed.push(link);
    });

  return claimed;
}

/** Undoes `claimLinks` exactly — driven by the list, never by a query. */
export function release(links: readonly HTMLAnchorElement[]): void {
  for (const link of links) {
    link.removeAttribute(CLAIMED);
    link.style.removeProperty('anchor-name');
    if (!link.getAttribute('style')) link.removeAttribute('style');
  }
}

function claimedLinkAt(target: EventTarget | null): HTMLAnchorElement | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  return target.closest<HTMLAnchorElement>(`a[${CLAIMED}]`);
}
