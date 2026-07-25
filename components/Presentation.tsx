import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { VIEWER_ROOT_ID, type SlideSplit } from '@/lib/config';
import { splitSlides, type Slide } from '@/lib/slides';

import './presentation.css';

/** Not memoized in place: a stable array keeps the closed state from re-rendering. */
const NO_SLIDES: Slide[] = [];

const FOCUSABLE =
  'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Full-screen presentation mode.
 *
 * The document is cut into slides by `lib/slides.ts` and one is shown at a
 * time. The shape follows `Lightbox`: everything lives in a portal onto
 * `document.body`, because a fixed overlay rendered inside the shell would sit
 * in its flex row, inside its stacking context, and under its sidebar.
 *
 * Two consequences of the portal are load-bearing and are dealt with rather
 * than assumed. Custom properties written inline on `.mdv` — the reader's font
 * family, size, measure — do not reach out here, so slide typography is built
 * from the `:root` tokens instead; that is the right answer anyway, since a
 * slide is sized for the back of a room and not for the reader's own comfort.
 * And the rules in `entrypoints/viewer.css` scoped to `#mdv-root` (focus ring,
 * box sizing, print strip) never match a node in here, so `presentation.css`
 * restates each one.
 *
 * `enabled` off means exactly nothing renders and no listener is attached.
 */
export function Presentation({
  html,
  split,
  enabled,
}: {
  /** The rendered document — the same string `Document` is given. */
  html: string;
  /** Where slides are cut. Straight from settings. */
  split: SlideSplit;
  /** The `presentation` setting, and only while a rendered document is on screen. */
  enabled: boolean;
}) {
  const [active, setActive] = useState(false);
  const [index, setIndex] = useState(0);

  const dialogRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the deck opened. */
  const returnRef = useRef<HTMLElement | null>(null);
  /** Whether *we* put the page into fullscreen, and therefore owe it an exit. */
  const fullscreenRef = useRef(false);

  // Splitting parses the whole document, so it is deferred until there is a
  // reason to: a 5 MB README costs nothing until someone presents it.
  const slides = useMemo(
    () => (active ? splitSlides(html, split) : NO_SLIDES),
    [active, html, split],
  );

  const total = slides.length;
  // A live reload can shorten the deck under a reader who is near its end.
  const position = Math.min(index, Math.max(0, total - 1));
  const slide = slides[position];

  const exit = useCallback(() => {
    setActive(false);

    if (fullscreenRef.current && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    fullscreenRef.current = false;
  }, []);

  const start = useCallback(() => {
    returnRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setIndex(0);
    setActive(true);

    // Requested on the document element rather than on the overlay, which does
    // not exist yet at this point in the click — and waiting a render for it
    // would spend the user activation the Fullscreen API insists on. Failure is
    // survivable by construction: the overlay is a fixed full-viewport surface
    // either way, so all a rejection costs is the browser chrome staying up.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().then(
        () => {
          fullscreenRef.current = true;
        },
        () => {
          fullscreenRef.current = false;
        },
      );
    }
  }, []);

  /** Clamps rather than wraps: a deck has an end, and arriving there is information. */
  const step = useCallback(
    (delta: number) => {
      setIndex((current) => Math.min(total - 1, Math.max(0, current + delta)));
    },
    [total],
  );

  // Turning the setting off, or switching to the raw view, has to take the deck
  // down with it rather than leaving an overlay nothing can reach.
  useEffect(() => {
    if (!enabled) setActive(false);
  }, [enabled]);

  useEffect(() => {
    if (index > position) setIndex(position);
  }, [index, position]);

  /* ------------------------------------------------------------------------ */
  /* Modal behaviour: fullscreen, scroll lock, inertness, focus                */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!active) return;

    // Escape while the page is in fullscreen is consumed by the browser and
    // never reaches a keydown handler, so losing fullscreen *is* the exit
    // signal — as it is for F11 and for the on-screen "exit full screen" chip.
    const onFullscreenChange = () => {
      if (fullscreenRef.current && !document.fullscreenElement) exit();
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () =>
      document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [active, exit]);

  useEffect(() => {
    if (!active) return;

    const root = document.getElementById(VIEWER_ROOT_ID);
    // Not named `html`: that is the prop this component is rendering.
    const page = document.documentElement;
    const previousOverflow = page.style.overflow;
    const returnTo = returnRef.current;

    page.style.overflow = 'hidden';
    // `inert` covers both halves of "modal" at once: the document leaves the
    // tab order and disappears from the accessibility tree.
    root?.setAttribute('inert', '');

    dialogRef.current?.focus();

    // The backstop under the Tab trap. Focus can also arrive from outside the
    // dialog — cycling back in from the browser chrome, or a stray programmatic
    // focus from an add-on that finished rendering behind the deck.
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      dialog.focus();
    };
    document.addEventListener('focusin', onFocusIn);

    return () => {
      // Before the focus call below, or this pulls it straight back.
      document.removeEventListener('focusin', onFocusIn);

      page.style.overflow = previousOverflow;
      // Un-inert first: focus() on a node inside an inert subtree does nothing.
      root?.removeAttribute('inert');

      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [active]);

  /* ------------------------------------------------------------------------ */
  /* Keyboard                                                                  */
  /* ------------------------------------------------------------------------ */

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A presentation owns the keyboard. The viewer's own unmodified shortcuts
    // (t, r, d, /) listen on `window`, and every one of them would otherwise
    // fire straight through and toggle the sidebar mid-slide. React's listener
    // for this portal sits on `document.body`, so stopping here is what keeps
    // the native event from reaching them.
    event.stopPropagation();

    if (event.key === 'Tab') {
      trapFocus(event, dialogRef.current);
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Not on the synthetic event; React does not surface it.
    if (event.nativeEvent.isComposing) return;

    // Space on a focused button is that button's own activation, and silently
    // turning "exit" into "next slide" is worse than losing one paging key.
    if (event.key === ' ' && event.target instanceof HTMLButtonElement) return;

    switch (event.key) {
      case 'Escape':
        exit();
        break;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
        step(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        step(-1);
        break;
      case ' ':
        // The one key that reverses under Shift, which is what every other
        // presenter does and what every presentation remote sends.
        step(event.shiftKey ? -1 : 1);
        break;
      case 'Home':
        setIndex(0);
        break;
      case 'End':
        setIndex(total - 1);
        break;
      default:
        return;
    }

    // Space and the paging keys scroll whatever is under them otherwise.
    event.preventDefault();
  };

  /* ------------------------------------------------------------------------ */

  if (!enabled) return null;

  if (!active) {
    return createPortal(
      <button
        type="button"
        className="mdv-present-launch"
        data-mdv-chrome
        aria-label="Present this document"
        title="Present"
        onClick={start}
      >
        <PlayIcon />
        Present
      </button>,
      document.body,
    );
  }

  const label = slide?.title
    ? `Slide ${position + 1} of ${total}: ${slide.title}`
    : `Slide ${position + 1} of ${total}`;

  return createPortal(
    <div
      className="mdv-present"
      // Read by the print rule that strips chrome by attribute rather than by
      // class name. Restated in presentation.css, since the rule in viewer.css
      // is scoped to `#mdv-root` and cannot see a portal.
      data-mdv-chrome
      onKeyDown={handleKeyDown}
      // Neutralizes the document-level listeners other features attach — the
      // lightbox in particular, which would otherwise open an image viewer on
      // top of the deck. Its listener is on `document`; React's for this portal
      // is on `document.body`, one step earlier.
      onClick={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        className="mdv-present-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Presentation"
        // Somewhere for focus to land on open that is not one of the controls,
        // so the deck does not start with "Next slide, button".
        tabIndex={-1}
      >
        <div className="mdv-present-stage">
          <div
            // A fresh element per slide, so the entrance animation actually
            // runs instead of being skipped as an update to an existing node.
            key={position}
            className="mdv-body mdv-present-content"
            role="region"
            aria-label={label}
            dangerouslySetInnerHTML={{ __html: slide?.html ?? '' }}
          />
        </div>

        <div className="mdv-present-progress" aria-hidden="true">
          <span style={{ width: `${((position + 1) / total) * 100}%` }} />
        </div>

        <div className="mdv-present-bar">
          {/* Polite: the reader drove the change, so it belongs after whatever
              is being read rather than on top of it. Atomic, or a screen reader
              announces the changed digit alone. */}
          <p className="mdv-present-count" aria-live="polite" aria-atomic="true">
            {label}
          </p>

          <div className="mdv-present-actions">
            <button
              type="button"
              className="mdv-present-button"
              aria-label="Previous slide"
              title="Previous slide (←)"
              disabled={position === 0}
              onClick={() => step(-1)}
            >
              <ChevronIcon direction="left" />
            </button>
            <button
              type="button"
              className="mdv-present-button"
              aria-label="Next slide"
              title="Next slide (→ or space)"
              disabled={position >= total - 1}
              onClick={() => step(1)}
            >
              <ChevronIcon direction="right" />
            </button>
            <button
              type="button"
              className="mdv-present-button"
              aria-label="Exit presentation"
              title="Exit (Esc)"
              onClick={exit}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Keeps Tab inside the dialog by wrapping at both ends.
 *
 * The document behind is already `inert`, so this is really about the browser's
 * own chrome: without it, Tab off the last control lands in the address bar and
 * the presenter has no way back except the mouse.
 */
function trapFocus(
  event: ReactKeyboardEvent<HTMLDivElement>,
  dialog: HTMLElement | null,
) {
  if (!dialog) return;

  const nodes = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // Rendered, rather than merely present: a control the current slide hides
    // is not somewhere Tab may land.
    (node) => node.getClientRects().length > 0,
  );
  if (nodes.length === 0) return;

  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;

  if (event.shiftKey ? active === first || active === dialog : active === last) {
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
      className="mdv-present-icon"
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

function PlayIcon() {
  return (
    <Icon>
      <path d="M2.6 3.2h10.8v7.2H2.6zM8 10.4v2.4M5.6 12.8h4.8" />
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

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <Icon>
      <path
        d={direction === 'left' ? 'M10 3.25 5.25 8 10 12.75' : 'M6 3.25 10.75 8 6 12.75'}
      />
    </Icon>
  );
}
