/**
 * Click an image to open it full-size, with gallery navigation and zoom.
 *
 * Migrated from `components/Lightbox.tsx`, which was the single biggest
 * beneficiary of the host owning modality. Deleted outright, not moved: the
 * `createPortal` onto `document.body`, the hand-picked z-index, the `inert` on
 * the shell, the `focusin` backstop, the `Tab` trap and the Escape case in the
 * key handler. All of it is `ctx.ui.openOverlay` now.
 *
 * Also deleted: the `MutationObserver` on the shell that watched for new images
 * and the `.mdv-body img` lookup it drove. `ctx.document.enhance` runs the claim
 * pass once per document, batched with every other plugin's, and its teardown
 * releases exactly the images it claimed.
 *
 * The one piece of the old modality that did *not* move is the scroll lock; see
 * the note on `close` below.
 */

import type { ComponentType } from 'react';

import {
  PLUGIN_API_VERSION,
  type OverlayHandle,
  type Plugin,
} from '../../lib/plugins/types.ts';

import { LightboxSession, type LightboxSlide } from './session.ts';

export const LIGHTBOX_PLUGIN_ID = 'lightbox';

/** The one overlay this plugin ever opens. `openOverlay` is idempotent per id. */
export const LIGHTBOX_OVERLAY_ID = 'lightbox';

/**
 * Marks an image this plugin has claimed, and the selector every delegated
 * handler matches on.
 *
 * An attribute rather than a class because `PURIFY_CONFIG` sets
 * `ALLOW_DATA_ATTR: false` — data-* cannot survive sanitization, so nothing in
 * an untrusted document can forge one and talk its way into the gallery.
 */
export const CLAIMED = 'data-mdv-zoomable';

export function createLightboxPlugin(
  overlay: ComponentType<{ close: () => void }>,
): Plugin {
  return {
    id: LIGHTBOX_PLUGIN_ID,
    name: 'Image viewer',
    description: 'Opens an image full size, with zoom and gallery navigation.',
    apiVersion: PLUGIN_API_VERSION,
    // Replaces the old `lightbox` setting: whether images open is this plugin's
    // enabled state, which is one concept rather than two.
    enabledByDefault: true,

    setup(ctx) {
      const session = new LightboxSession();
      ctx.capabilities.provide('lightbox', session);

      /** The open overlay, or null. One at a time, by construction. */
      let handle: OverlayHandle | null = null;

      const close = () => handle?.close();

      const open = (image: HTMLImageElement) => {
        const body = ctx.document.body;
        if (!body) return;

        const slides = collectSlides(body);
        const index = slides.findIndex((candidate) => candidate.image === image);
        if (index < 0) return;

        session.open(slides, index);

        handle = ctx.ui.openOverlay({
          id: LIGHTBOX_OVERLAY_ID,
          label: 'Image viewer',
          component: overlay,
          // Every close path arrives here: Escape and the focus restore are the
          // host's, the exit button and the backdrop are the overlay's, and the
          // host closes it outright when this plugin is disabled.
          onClose: () => {
            const target = session.current;
            handle = null;
            session.clear();
            restoreFocus(target);
          },
        });
      };

      const stop = ctx.document.enhance((body) => {
        // The raw view is one `<pre>` of source text: no images to claim, and
        // an overlay left over one would be covering a document that is gone.
        if (ctx.document.isRaw) {
          close();
          return;
        }

        const claimed = claimImages(body);

        // A live reload replaces the whole body. The slide on screen is then a
        // node in no document, and there is nothing left to return focus to.
        if (session.current && !session.current.isConnected) close();

        const onClick = (event: MouseEvent) => {
          if (event.defaultPrevented || event.button !== 0) return;
          // Modified clicks belong to the browser — open in tab, download, and
          // on some platforms the context menu.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

          const image = claimedImageAt(event.target);
          if (!image) return;

          event.preventDefault();
          open(image);
        };

        // A claimed image carries `role="button"`, and a button that ignores
        // Enter and Space is a lie. Nothing in the DOM supplies this for an
        // <img>.
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.defaultPrevented || event.isComposing) return;

          const image = claimedImageAt(event.target);
          if (!image) return;

          // Space would otherwise page the document down behind the overlay.
          event.preventDefault();
          open(image);
        };

        // On the body rather than on `document`: the body is what the pass was
        // handed, so these unbind with the document they were registered for
        // instead of outliving it.
        body.addEventListener('click', onClick);
        body.addEventListener('keydown', onKeyDown);

        return () => {
          body.removeEventListener('click', onClick);
          body.removeEventListener('keydown', onKeyDown);
          release(claimed);
        };
      });

      return () => {
        // The host has already closed our overlay by the time this runs, which
        // fired `onClose` and released the session.
        stop();
        session.clear();
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The document side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Gives every eligible image in the body the affordance, and reports which.
 *
 * The `:not` is what keeps this cheap on a re-run: an image already claimed
 * never reaches the callback. Nothing is read back off the layout, so the whole
 * pass is one batch of attribute writes.
 */
function claimImages(body: HTMLElement): HTMLImageElement[] {
  const claimed: HTMLImageElement[] = [];

  body.querySelectorAll<HTMLImageElement>(`img:not([${CLAIMED}])`).forEach((image) => {
    // A linked image already has a job. Following the link is what its author
    // asked for, and a lightbox that swallowed that click would be a bug.
    if (image.closest('a')) return;

    image.setAttribute(CLAIMED, '');
    image.setAttribute('tabindex', '0');
    // `role="button"` costs the image its graphic role, which is a real loss —
    // but a bare <img> announces nothing about being activatable, and this is
    // the one affordance a screen reader otherwise cannot discover at all. The
    // alt text is carried into the label, and the overlay re-presents the image
    // with its alt intact.
    image.setAttribute('role', 'button');

    const alt = image.getAttribute('alt')?.trim();
    image.setAttribute(
      'aria-label',
      alt ? `${alt} — view full size` : 'View image full size',
    );

    claimed.push(image);
  });

  return claimed;
}

/**
 * Undoes `claimImages` completely — disabling leaves no residue.
 *
 * Driven by the list the pass built rather than by a query, so it releases
 * exactly what it claimed and never an image some other feature marked.
 */
function release(images: readonly HTMLImageElement[]): void {
  for (const image of images) {
    image.removeAttribute(CLAIMED);
    image.removeAttribute('tabindex');
    image.removeAttribute('role');
    image.removeAttribute('aria-label');
  }
}

function claimedImageAt(target: EventTarget | null): HTMLImageElement | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  return target.closest<HTMLImageElement>(`img[${CLAIMED}]`);
}

/** Every claimed image, in document order. Read once per open. */
function collectSlides(body: HTMLElement): LightboxSlide[] {
  const images = body.querySelectorAll<HTMLImageElement>(`img[${CLAIMED}]`);

  return [...images].map((image) => ({
    image,
    // `currentSrc` is the URL the browser actually resolved and already holds;
    // `src` covers the case of an image that has not started loading yet.
    src: image.currentSrc || image.src,
    alt: image.getAttribute('alt') ?? '',
    title: image.getAttribute('title') ?? '',
  }));
}

/**
 * Puts focus back on the slide the reader navigated to.
 *
 * The host already restores focus to whatever held it when the overlay opened,
 * which is the image that was clicked. That is the right answer in the common
 * case and the wrong one after arrowing through a gallery, so this refines it —
 * from a frame later, because the host's restore runs in its own cleanup and
 * this has to be the last word rather than a race with it.
 */
function restoreFocus(target: HTMLImageElement | null): void {
  if (!target?.isConnected) return;

  const put = () => {
    if (!target.isConnected) return;
    target.focus({ preventScroll: true });
    // Focus alone will not reveal an image that was scrolled off while the
    // overlay covered the page.
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(put);
  else setTimeout(put, 0);
}
