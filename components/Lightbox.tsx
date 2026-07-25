import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { VIEWER_ROOT_ID } from '@/lib/config';

import './lightbox.css';

/**
 * Marks an image this component has claimed, and the selector every delegated
 * handler matches on.
 *
 * An attribute rather than a class because `PURIFY_CONFIG` sets
 * `ALLOW_DATA_ATTR: false` — data-* cannot survive sanitization, so nothing in
 * an untrusted document can forge one and talk its way into the gallery.
 */
const CLAIMED = 'data-mdv-zoomable';

/** Scale 1 is fit-to-screen, not 1:1 — the image is laid out with `max-*: 100%`. */
const FIT = 1;
const MAX_SCALE = 8;
/** Multiplier per `+`/`-` press or button click. */
const ZOOM_STEP = 1.5;
/** Where a click on the image lands when it is currently fitted. */
const CLICK_SCALE = 2.5;
/** Wheel delta to zoom factor. Exponential, so a fast flick is not linear. */
const WHEEL_SENSITIVITY = 0.0015;
/** Movement past this is a pan, not a click, and must not toggle the zoom. */
const DRAG_SLOP_PX = 4;

/** Everything in the overlay that a click belongs to; anything else dismisses. */
const SOLID = '.mdv-lightbox-solid';

const FOCUSABLE =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

interface Slide {
  /** The element in the document. Kept for focus restore, never re-parented. */
  image: HTMLImageElement;
  src: string;
  alt: string;
  title: string;
}

interface Session {
  slides: Slide[];
  index: number;
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const VIEW_RESET: View = { scale: FIT, x: 0, y: 0 };

/**
 * Click an image to open it full-size, with gallery navigation and zoom.
 *
 * The images this operates on are inside `.mdv-body`, which is injected HTML —
 * React owns none of it. So the shape here is the same one `Document.tsx`
 * settled on: one delegated listener for the whole document, and one idempotent
 * pass that grafts the affordance onto the images. The difference is that this
 * component is a sibling of the body rather than its owner, so it has no render
 * to hang the pass off and watches the DOM for new images instead.
 *
 * The overlay itself is a portal onto `document.body`. Rendering it in place
 * would put it inside the shell's flex row, where `overflow` on an ancestor and
 * the sidebar's stacking context both have an opinion about it.
 *
 * `enabled` off means exactly nothing happens: no listener, no observer, and no
 * attribute left on any image.
 */
export function Lightbox({ enabled }: { enabled: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>(VIEW_RESET);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragging, setDragging] = useState(false);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // The transform is read inside pointer and wheel handlers that were created
  // on an earlier render; a mirror keeps them off a stale copy of it.
  const viewRef = useRef(view);
  /** Whatever had focus when the overlay opened. The fallback for restore. */
  const returnRef = useRef<HTMLElement | null>(null);
  /** The image focus goes back to on close. Tracked so it survives the close. */
  const focusTargetRef = useRef<HTMLImageElement | null>(null);
  const panRef = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const movedRef = useRef(false);

  const captionId = useId();

  const slide = session ? session.slides[session.index] : null;
  const total = session ? session.slides.length : 0;

  const applyView = useCallback((next: View) => {
    const clamped = clampView(next, stageRef.current, imageRef.current);
    viewRef.current = clamped;
    setView(clamped);
  }, []);

  /**
   * Zoom, keeping whatever sits under `anchor` under `anchor`.
   *
   * The anchor is in stage coordinates measured from the stage centre, which is
   * also the transform origin — so the image point beneath it is
   * `(anchor - offset) / scale`, and holding that fixed gives the offset below.
   * Omitting the anchor zooms about the centre, which is what the buttons and
   * the `+`/`-` keys want.
   */
  const zoomTo = useCallback(
    (nextScale: number, anchor?: { x: number; y: number }) => {
      const previous = viewRef.current;
      const scale = Math.min(MAX_SCALE, Math.max(FIT, nextScale));
      const ratio = scale / previous.scale;
      const ax = anchor?.x ?? 0;
      const ay = anchor?.y ?? 0;

      applyView({
        scale,
        x: ax - (ax - previous.x) * ratio,
        y: ay - (ay - previous.y) * ratio,
      });
    },
    [applyView],
  );

  const open = useCallback((image: HTMLImageElement) => {
    const slides = collectSlides();
    const index = slides.findIndex((candidate) => candidate.image === image);
    if (index < 0) return;

    returnRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSession({ slides, index });
  }, []);

  const close = useCallback(() => setSession(null), []);

  /** Wraps rather than stops: the counter says where you are, so a ring is safe. */
  const step = useCallback((delta: number) => {
    setSession((current) => {
      if (!current) return current;
      const count = current.slides.length;
      return { ...current, index: (current.index + delta + count) % count };
    });
  }, []);

  /* ------------------------------------------------------------------------ */
  /* Claiming the document's images                                            */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!enabled) return;

    // Watching the shell rather than `document.body` keeps the overlay's own
    // portal — a sibling of the shell — from feeding records back in.
    const root = document.getElementById(VIEWER_ROOT_ID) ?? document.body;

    let frame = 0;
    const sweep = () => {
      frame = 0;
      claimImages();

      // A live reload or a raw-view toggle replaces the whole body. The slide
      // on screen is then a node in no document, and there is nothing left to
      // return focus to.
      const target = focusTargetRef.current;
      if (target && !target.isConnected) close();
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(sweep);
    };

    claimImages();

    // Attributes are deliberately not observed: the pass writes attributes, so
    // watching them would have it retrigger itself forever.
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      // Modified clicks belong to the browser — open in tab, download, and on
      // some platforms the context menu.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const image = claimedImageAt(event.target);
      if (!image) return;

      event.preventDefault();
      open(image);
    };

    // A claimed image carries `role="button"`, and a button that ignores Enter
    // and Space is a lie. Nothing in the DOM supplies this for an <img>.
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

    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
      // Turning the setting off has to leave the document as it was found.
      releaseImages();
      setSession(null);
    };
  }, [enabled, open, close]);

  /* ------------------------------------------------------------------------ */
  /* Per-slide state                                                           */
  /* ------------------------------------------------------------------------ */

  // Layout rather than passive: both the transform and the loading state belong
  // to the slide being shown, and a passive effect would let the browser paint
  // one frame of the previous image's zoom, or of a spinner over a picture that
  // was decoded long ago.
  useLayoutEffect(() => {
    if (!slide) return;

    focusTargetRef.current = slide.image;
    viewRef.current = VIEW_RESET;
    setView(VIEW_RESET);

    // The document already holds this image, so its own element is both the
    // cheapest and the most accurate source of truth: an already-decoded copy
    // means the overlay paints the picture immediately instead of flashing a
    // spinner at a bitmap the browser is holding in memory.
    setStatus(
      slide.image.complete
        ? slide.image.naturalWidth > 0
          ? 'ready'
          : 'error'
        : 'loading',
    );
  }, [slide]);

  /* ------------------------------------------------------------------------ */
  /* Modal behaviour: scroll lock, inertness, focus                            */
  /* ------------------------------------------------------------------------ */

  const isOpen = session !== null;

  useEffect(() => {
    if (!isOpen) return;

    const root = document.getElementById(VIEWER_ROOT_ID);
    const html = document.documentElement;
    const previousOverflow = html.style.overflow;
    const previousPadding = html.style.paddingRight;
    const returnTo = returnRef.current;

    // Locking the scroll removes the scrollbar, and with it a slice of the
    // viewport width the document is laid out against. Paying it back as
    // padding keeps the page from reflowing under the overlay and snapping
    // back on close. Fixed chrome is positioned against the viewport and is
    // unaffected either way.
    const gutter = window.innerWidth - html.clientWidth;
    html.style.overflow = 'hidden';
    if (gutter > 0) html.style.paddingRight = `${gutter}px`;

    // `inert` is the one flag that covers both halves of "modal": the document
    // leaves the tab order and disappears from the accessibility tree, so no
    // aria-hidden is needed alongside it.
    root?.setAttribute('inert', '');

    closeRef.current?.focus();

    // The backstop under the Tab trap below. Tab is handled inside the dialog,
    // but focus can also arrive from outside it — cycling back in from the
    // browser chrome, or a stray programmatic focus.
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      closeRef.current?.focus();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      // Before the focus call below, or this pulls it straight back.
      document.removeEventListener('focusin', onFocusIn);

      html.style.overflow = previousOverflow;
      html.style.paddingRight = previousPadding;
      // Un-inert first: focus() on a node inside an inert subtree does nothing.
      root?.removeAttribute('inert');

      // The image that was on screen, not the one that was clicked — after
      // arrowing through a gallery, the reader's place is where they navigated
      // to. They are the same element in the common case of not navigating.
      const target = focusTargetRef.current;
      const restore = target?.isConnected
        ? target
        : returnTo?.isConnected
          ? returnTo
          : null;

      if (restore) {
        restore.focus({ preventScroll: true });
        // Focus alone will not reveal an image that was scrolled off while the
        // overlay covered the page.
        restore.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    };
  }, [isOpen]);

  /**
   * Wheel-zoom, attached by hand because React registers `wheel` passively and
   * `preventDefault` from a passive listener does nothing. Without it the page
   * behind the overlay scrolls while the image zooms.
   */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!isOpen || !overlay) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();

      const stage = stageRef.current;
      if (!stage) return;

      // deltaY arrives in pixels, lines or pages depending on the device.
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const factor = Math.exp(-event.deltaY * unit * WHEEL_SENSITIVITY);

      zoomTo(viewRef.current.scale * factor, stagePoint(event, stage));
    };

    overlay.addEventListener('wheel', onWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', onWheel);
  }, [isOpen, zoomTo]);

  /* ------------------------------------------------------------------------ */
  /* Handlers                                                                  */
  /* ------------------------------------------------------------------------ */

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A modal owns the keyboard. The viewer's own unmodified shortcuts (t, r,
    // d, /) listen on window, and every one of them would otherwise fire
    // straight through the overlay.
    event.stopPropagation();

    if (event.key === 'Tab') {
      trapFocus(event, dialogRef.current);
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key) {
      case 'Escape':
        close();
        break;
      // Arrows always navigate, never pan, even when zoomed in: navigating
      // resets the zoom anyway, and one key doing two things depending on
      // invisible state is worse than dragging to pan.
      case 'ArrowRight':
        step(1);
        break;
      case 'ArrowLeft':
        step(-1);
        break;
      case '+':
      case '=':
        zoomTo(viewRef.current.scale * ZOOM_STEP);
        break;
      case '-':
      case '_':
        zoomTo(viewRef.current.scale / ZOOM_STEP);
        break;
      case '0':
        applyView(VIEW_RESET);
        break;
      default:
        return;
    }

    event.preventDefault();
  };

  const handleOverlayClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // The tail of a pan that finished over the backdrop, not a click on it.
    if (movedRef.current) return;
    if (event.target instanceof Element && event.target.closest(SOLID)) return;
    close();
  };

  const handleImageClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (movedRef.current) return;

    const stage = stageRef.current;
    zoomTo(
      viewRef.current.scale > FIT ? FIT : CLICK_SCALE,
      stage ? stagePoint(event, stage) : undefined,
    );
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0 || viewRef.current.scale <= FIT) return;

    // Capture, so a drag that leaves the image — or the window — still tracks.
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewRef.current.x,
      originY: viewRef.current.y,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointer !== event.pointerId) return;

    const dx = event.clientX - pan.startX;
    const dy = event.clientY - pan.startY;
    if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX) {
      movedRef.current = true;
    }

    applyView({
      scale: viewRef.current.scale,
      x: pan.originX + dx,
      y: pan.originY + dy,
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointer !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panRef.current = null;
    setDragging(false);
  };

  /* ------------------------------------------------------------------------ */

  if (!enabled || !session || !slide) return null;

  const alt = slide.alt.trim();
  const title = slide.title.trim();
  // The title is only worth its own line when it says something the alt does not.
  const showTitle = title.length > 0 && title !== alt;
  const hasCaption = alt.length > 0 || showTitle;
  const zoomed = view.scale > FIT;

  return createPortal(
    <div
      ref={overlayRef}
      className="mdv-lightbox"
      // Read by the print rule in viewer.css that strips every piece of chrome
      // by attribute rather than by class name.
      data-mdv-chrome
      onKeyDown={handleKeyDown}
      onClick={handleOverlayClick}
      onPointerDownCapture={() => {
        movedRef.current = false;
      }}
    >
      <div
        ref={dialogRef}
        className="mdv-lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
        aria-describedby={hasCaption ? captionId : undefined}
      >
        <div className="mdv-lightbox-bar mdv-lightbox-solid">
          {/* Polite rather than assertive: the reader drove the change, so it
              belongs after whatever is being read, not on top of it. */}
          <p className="mdv-lightbox-count" aria-live="polite">
            {session.index + 1} of {total}
          </p>

          <div className="mdv-lightbox-actions">
            <button
              type="button"
              className="mdv-lightbox-button"
              aria-label="Zoom out"
              title="Zoom out (-)"
              disabled={!zoomed}
              onClick={() => zoomTo(viewRef.current.scale / ZOOM_STEP)}
            >
              <MinusIcon />
            </button>
            <button
              type="button"
              className="mdv-lightbox-button"
              aria-label="Fit image to screen"
              title="Fit to screen (0)"
              disabled={!zoomed}
              onClick={() => applyView(VIEW_RESET)}
            >
              <FitIcon />
            </button>
            <button
              type="button"
              className="mdv-lightbox-button"
              aria-label="Zoom in"
              title="Zoom in (+)"
              disabled={view.scale >= MAX_SCALE}
              onClick={() => zoomTo(viewRef.current.scale * ZOOM_STEP)}
            >
              <PlusIcon />
            </button>
            <button
              ref={closeRef}
              type="button"
              className="mdv-lightbox-button"
              aria-label="Close image viewer"
              title="Close (Esc)"
              onClick={close}
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <figure className="mdv-lightbox-figure">
          <div className="mdv-lightbox-stage" ref={stageRef}>
            {total > 1 ? (
              <button
                type="button"
                className="mdv-lightbox-nav mdv-lightbox-solid"
                data-side="prev"
                aria-label="Previous image"
                title="Previous image (←)"
                onClick={() => step(-1)}
              >
                <ChevronIcon direction="left" />
              </button>
            ) : null}

            <img
              // A fresh element per slide, so `onLoad` is guaranteed to fire
              // for each one rather than being swallowed by a src swap on an
              // already-loaded node.
              key={slide.src}
              ref={imageRef}
              className="mdv-lightbox-image mdv-lightbox-solid"
              // The address the document already resolved. Nothing is derived,
              // rewritten or re-requested — the browser serves this from the
              // copy it decoded for the page.
              src={slide.src}
              alt={slide.alt}
              draggable={false}
              data-mdv-state={status}
              data-mdv-zoom={zoomed ? 'in' : 'fit'}
              data-mdv-drag={dragging ? '' : undefined}
              style={{
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              }}
              onLoad={() => setStatus('ready')}
              onError={() => setStatus('error')}
              onClick={handleImageClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />

            {status === 'ready' ? null : (
              <p className="mdv-lightbox-state mdv-lightbox-solid" role="status">
                {status === 'error' ? (
                  <>
                    <BrokenIcon />
                    This image could not be displayed.
                  </>
                ) : (
                  <>
                    <span className="mdv-lightbox-spinner" aria-hidden="true" />
                    Loading image…
                  </>
                )}
              </p>
            )}

            {total > 1 ? (
              <button
                type="button"
                className="mdv-lightbox-nav mdv-lightbox-solid"
                data-side="next"
                aria-label="Next image"
                title="Next image (→)"
                onClick={() => step(1)}
              >
                <ChevronIcon direction="right" />
              </button>
            ) : null}
          </div>

          {/* No alt and no title means the document gave this image no
              description, and inventing one is worse than showing none. */}
          {hasCaption ? (
            <figcaption
              id={captionId}
              className="mdv-lightbox-caption mdv-lightbox-solid"
            >
              {alt ? <span>{alt}</span> : null}
              {showTitle ? (
                <span className="mdv-lightbox-title">{title}</span>
              ) : null}
            </figcaption>
          ) : null}
        </figure>
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */
/* The document side                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Gives every eligible image in the body the affordance, once.
 *
 * Idempotent and cheap enough to re-run on any mutation: the work is one query
 * plus a handful of attribute writes on images that are new, and nothing is
 * read back off the layout.
 */
function claimImages() {
  // The `:not` is what makes re-running this on every mutation cheap: an image
  // that has already been claimed never reaches the callback at all.
  const images = document.querySelectorAll<HTMLImageElement>(
    `.mdv-body img:not([${CLAIMED}])`,
  );

  images.forEach((image) => {
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
  });
}

/** Undoes `claimImages` completely — the setting going off leaves no residue. */
function releaseImages() {
  document
    .querySelectorAll<HTMLImageElement>(`img[${CLAIMED}]`)
    .forEach((image) => {
      image.removeAttribute(CLAIMED);
      image.removeAttribute('tabindex');
      image.removeAttribute('role');
      image.removeAttribute('aria-label');
    });
}

function claimedImageAt(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLImageElement>(`img[${CLAIMED}]`);
}

/** Every claimed image, in document order. Read once per open. */
function collectSlides(): Slide[] {
  const images = document.querySelectorAll<HTMLImageElement>(
    `.mdv-body img[${CLAIMED}]`,
  );

  return [...images].map((image) => ({
    image,
    // `currentSrc` is the URL the browser actually resolved and already holds;
    // `src` covers the case of an image that has not started loading yet.
    src: image.currentSrc || image.src,
    alt: image.getAttribute('alt') ?? '',
    title: image.getAttribute('title') ?? '',
  }));
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/** A pointer position in stage coordinates, measured from the stage centre. */
function stagePoint(
  event: { clientX: number; clientY: number },
  stage: HTMLElement,
): { x: number; y: number } {
  const box = stage.getBoundingClientRect();
  return {
    x: event.clientX - (box.left + box.width / 2),
    y: event.clientY - (box.top + box.height / 2),
  };
}

/**
 * Holds the transform inside the range that keeps the picture on screen.
 *
 * `offsetWidth` is the laid-out size, which the transform does not affect — so
 * the overflow the pan is clamped against never feeds back on itself the way it
 * would with a measured bounding box.
 */
function clampView(
  view: View,
  stage: HTMLElement | null,
  image: HTMLImageElement | null,
): View {
  const scale = Math.min(MAX_SCALE, Math.max(FIT, view.scale));

  // Fitted, the image is already centred and there is nothing to pan to.
  if (!stage || !image || scale === FIT) return VIEW_RESET;

  const limitX = Math.max(0, (image.offsetWidth * scale - stage.clientWidth) / 2);
  const limitY = Math.max(
    0,
    (image.offsetHeight * scale - stage.clientHeight) / 2,
  );

  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
}

/**
 * Keeps Tab inside the dialog by wrapping at both ends.
 *
 * The document behind is already `inert`, so this is really about the browser's
 * own chrome: without it, Tab off the last control lands in the address bar and
 * the reader has no way back except the mouse.
 */
function trapFocus(
  event: ReactKeyboardEvent<HTMLDivElement>,
  dialog: HTMLElement | null,
) {
  if (!dialog) return;

  const nodes = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // Rendered, rather than merely present: a control the current state hides
    // is not somewhere Tab may land. `getClientRects` is the check that works
    // for positioned elements, which `offsetParent` is not.
    (node) => node.getClientRects().length > 0,
  );
  if (nodes.length === 0) return;

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;

  if (event.shiftKey ? active === first : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="mdv-lightbox-icon"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function PlusIcon() {
  return (
    <Icon>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </Icon>
  );
}

function MinusIcon() {
  return (
    <Icon>
      <path d="M3.2 8h9.6" />
    </Icon>
  );
}

function FitIcon() {
  return (
    <Icon>
      <path d="M6.2 2.6H2.6v3.6M9.8 2.6h3.6v3.6M6.2 13.4H2.6V9.8M9.8 13.4h3.6V9.8" />
    </Icon>
  );
}

function CloseIcon() {
  return (
    <Icon>
      <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
    </Icon>
  );
}

function BrokenIcon() {
  return (
    <Icon>
      <path d="M2.4 3.4h11.2v9.2H2.4z" />
      <path d="M2.4 10.2 5.6 7l2.6 2.6M9.4 12.6l2-2.4 2.2 1.9" />
    </Icon>
  );
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <Icon>
      <path d={direction === 'left' ? 'M10 3.25 5.25 8 10 12.75' : 'M6 3.25 10.75 8 6 12.75'} />
    </Icon>
  );
}
