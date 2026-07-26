import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { usePlugin } from '../../lib/plugins/react.tsx';

import './lightbox.css';

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

interface View {
  scale: number;
  x: number;
  y: number;
}

const VIEW_RESET: View = { scale: FIT, x: 0, y: 0 };

const noopSubscribe = () => () => {};

/**
 * The image viewer, as the host renders it.
 *
 * Everything modal about this component is gone, because the host owns it: no
 * `createPortal`, no z-index, no `inert` on the shell, no `focusin` backstop, no
 * Tab trap, no `role="dialog"` of its own, and no Escape case in the key
 * handler. What is left is a picture, its zoom, and the controls around it.
 *
 * Which picture comes from the `lightbox` capability rather than from a prop: a
 * contribution is declared before any context exists and the host gives it no
 * props but `close`, so the session the plugin's `setup` opened is published and
 * read back here. Neither half imports the other's module.
 */
export function LightboxOverlay({ close }: { close: () => void }) {
  const plugin = usePlugin();
  const session = plugin.capabilities.use('lightbox');

  const snapshot = useSyncExternalStore(
    session?.store.subscribe ?? noopSubscribe,
    () => session?.store.get() ?? null,
    () => null,
  );

  const [view, setView] = useState<View>(VIEW_RESET);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragging, setDragging] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // The transform is read inside pointer and wheel handlers that were created
  // on an earlier render; a mirror keeps them off a stale copy of it.
  const viewRef = useRef(view);
  const panRef = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const movedRef = useRef(false);

  const slide = snapshot ? snapshot.slides[snapshot.index] : null;
  const total = snapshot ? snapshot.slides.length : 0;

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

  const step = useCallback(
    (delta: number) => {
      session?.step(delta);
    },
    [session],
  );

  /* ------------------------------------------------------------------------ */
  /* Per-slide state                                                           */
  /* ------------------------------------------------------------------------ */

  // Layout rather than passive: both the transform and the loading state belong
  // to the slide being shown, and a passive effect would let the browser paint
  // one frame of the previous image's zoom, or of a spinner over a picture that
  // was decoded long ago.
  useLayoutEffect(() => {
    if (!slide) return;

    viewRef.current = VIEW_RESET;
    setView(VIEW_RESET);

    // The document already holds this image, so its own element is both the
    // cheapest and the most accurate source of truth: an already-decoded copy
    // means the overlay paints the picture immediately instead of flashing a
    // spinner at a bitmap the browser is holding in memory.
    setStatus(
      slide.image.complete ? (slide.image.naturalWidth > 0 ? 'ready' : 'error') : 'loading',
    );
  }, [slide]);

  /**
   * Wheel-zoom, attached by hand because React registers `wheel` passively and
   * `preventDefault` from a passive listener does nothing. Without it the page
   * behind the overlay scrolls while the image zooms.
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

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

    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  /* ------------------------------------------------------------------------ */
  /* Handlers                                                                  */
  /* ------------------------------------------------------------------------ */

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A modal owns the keyboard. The viewer's own unmodified shortcuts (t, r,
    // d, /) listen on window, and every one of them would otherwise fire
    // straight through the overlay.
    //
    // Escape is the exception, in both directions: the host listens for it in
    // the capture phase and closes the top overlay, so it never arrives here to
    // be handled — and stopping its propagation would be pointless rather than
    // harmful. Tab is likewise the host's, and is no longer trapped here.
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    switch (event.key) {
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

  if (!snapshot || !slide) return null;

  const alt = slide.alt.trim();
  const title = slide.title.trim();
  // The title is only worth its own line when it says something the alt does not.
  const showTitle = title.length > 0 && title !== alt;
  const hasCaption = alt.length > 0 || showTitle;
  const zoomed = view.scale > FIT;

  return (
    // No portal: the host's surface is already fixed, stacked and portalled, and
    // already carries `role="dialog"`, `aria-modal` and the label the plugin
    // handed to `openOverlay`.
    <div
      ref={rootRef}
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
      <div className="mdv-lightbox-dialog">
        <div className="mdv-lightbox-bar mdv-lightbox-solid">
          {/* Polite rather than assertive: the reader drove the change, so it
              belongs after whatever is being read, not on top of it. */}
          <p className="mdv-lightbox-count" aria-live="polite">
            {snapshot.index + 1} of {total}
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
              description, and inventing one is worse than showing none.

              The caption used to be wired to the dialog with `aria-describedby`.
              The dialog is now the host's element, and `OverlayOptions` carries
              a label but no description — so the association is the figure's
              own, which is weaker. Reported rather than worked around. */}
          {hasCaption ? (
            <figcaption className="mdv-lightbox-caption mdv-lightbox-solid">
              {alt ? <span>{alt}</span> : null}
              {showTitle ? <span className="mdv-lightbox-title">{title}</span> : null}
            </figcaption>
          ) : null}
        </figure>
      </div>
    </div>
  );
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
  const limitY = Math.max(0, (image.offsetHeight * scale - stage.clientHeight) / 2);

  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
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
      <path
        d={direction === 'left' ? 'M10 3.25 5.25 8 10 12.75' : 'M6 3.25 10.75 8 6 12.75'}
      />
    </Icon>
  );
}
