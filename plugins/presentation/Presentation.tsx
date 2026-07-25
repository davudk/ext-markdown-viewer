import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { renderMarkdown } from '../../lib/markdown.ts';
import { usePlugin, useDocument, usePluginSettings } from '../../lib/plugins/react.tsx';
import type { DocumentHandle } from '../../lib/plugins/types.ts';
import { splitSlides } from '../../lib/slides.ts';

import { PRESENT_COMMAND, type PresentationSettings } from './plugin.ts';
import './presentation.css';

/**
 * The two views presentation mode contributes: a launcher in a corner of a
 * rendered document, and the deck that opens from it.
 *
 * Both used to be one component that portalled itself onto `document.body`,
 * because a fixed overlay rendered inside the shell would sit in its flex row,
 * inside its stacking context, and under its sidebar. The host owns that now:
 * the launcher is placed by a region, and the deck is a managed overlay — which
 * is also what took the focus trap, the `inert` handling and Escape out of this
 * file.
 *
 * One consequence of living outside `#mdv-root` survives the move and is dealt
 * with rather than assumed: custom properties written inline on `.mdv` — the
 * reader's font family, size and measure — do not reach the overlay layer, so
 * slide typography is built from the `:root` tokens instead. That is the right
 * answer anyway, since a slide is sized for the back of a room and not for the
 * reader's own comfort.
 */

/* -------------------------------------------------------------------------- */
/* Reading the shared document                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A value off the shared document, re-read whenever the document changes.
 *
 * `useDocument()` on its own re-renders on plugin *status* changes — enable,
 * disable, a settings write — and not on a render, a live reload or a raw
 * toggle, which are exactly the three this needs. The handle's own `onChange`
 * is the subscription that does fire for those.
 */
function useDocumentValue<T>(read: (doc: DocumentHandle) => T): T {
  const doc = useDocument();
  // Wrapped rather than handed over as `doc.onChange`: React calls the
  // subscriber unbound, and the handle keeps its watchers on `this`.
  const subscribe = useCallback((notify: () => void) => doc.onChange(notify), [doc]);
  return useSyncExternalStore(subscribe, () => read(doc));
}

/* -------------------------------------------------------------------------- */
/* Launcher                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The corner button, contributed to `chrome.bottom-end`.
 *
 * Conditional rendering is the contribution's own business, which is what
 * replaced the `enabled` prop the shell used to thread: whether the feature is
 * on is the host's answer, and whether the raw view is showing is this one's.
 */
export function PresentationLauncher() {
  const plugin = usePlugin();
  const isRaw = useDocumentValue((doc) => doc.isRaw);

  // The command is the launcher's only route to the deck: a contribution is a
  // plain component, with no channel to the closure in `setup` that holds the
  // open overlay and the fullscreen it owns.
  const start = plugin.commands.all().find((command) => command.id === PRESENT_COMMAND);
  if (isRaw || !start) return null;

  return (
    <button
      type="button"
      className="mdv-present-launch"
      data-mdv-chrome
      aria-label="Present this document"
      title="Present (P)"
      onClick={() => void start.run()}
    >
      <PlayIcon />
      Present
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Deck                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The deck, rendered by the host inside its managed overlay.
 *
 * `close` is the host's: it unwinds the overlay stack, un-inerts the document
 * and restores focus, and it is what the plugin hangs the fullscreen exit off.
 * Nothing in here takes itself down by hand.
 */
export function PresentationDeck({ close }: { close: () => void }) {
  const { slideSplit } = usePluginSettings<PresentationSettings>();
  const source = useDocumentValue((doc) => doc.source);

  const [index, setIndex] = useState(0);

  /**
   * Rendered here rather than handed over by the shell.
   *
   * `DocumentHandle` carries the source and the live body, but not the HTML the
   * shell already rendered — and the live body is not a substitute for it: by
   * the time a plugin can see it, the copy buttons, the heading anchors and
   * every other enhancement pass are in it, and a slide is no place for a Copy
   * button. Re-rendering the same source through the same pipeline is the one
   * way back to the string the document was built from. The second parse is
   * paid only when someone actually presents, which is also why splitting is
   * still done here rather than kept warm: a 5 MB README costs nothing until
   * then.
   */
  const slides = useMemo(
    () => splitSlides(renderMarkdown(source).html, slideSplit),
    [source, slideSplit],
  );

  const total = slides.length;
  // A live reload can shorten the deck under a reader who is near its end.
  const position = Math.min(index, Math.max(0, total - 1));
  const slide = slides[position];

  /** Clamps rather than wraps: a deck has an end, and arriving there is information. */
  const step = useCallback(
    (delta: number) => {
      setIndex((current) => Math.min(total - 1, Math.max(0, current + delta)));
    },
    [total],
  );

  useEffect(() => {
    if (index > position) setIndex(position);
  }, [index, position]);

  /**
   * Scroll lock — the one piece of "modal" the overlay manager does not own.
   *
   * Stacking, `inert` beneath, the focus trap and its restore, and Escape are
   * all the host's now. Scrolling is not: `inert` stops interaction, not wheel
   * events, and the deck is opaque, so a flick anywhere but the stage would
   * scroll the document invisibly and leave the reader somewhere else when the
   * deck closes. The stage handles its own axis with `overscroll-behavior`;
   * this covers the rest of the surface.
   */
  useEffect(() => {
    const page = document.documentElement;
    const previous = page.style.overflow;
    page.style.overflow = 'hidden';
    return () => {
      page.style.overflow = previous;
    };
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A presentation owns the keyboard. The viewer's own unmodified shortcuts
    // (t, r, d, /) listen on `window` and would otherwise fire straight through
    // and toggle the sidebar mid-slide. React's listener for this tree sits on
    // `document.body`, so stopping here is what keeps the native event from
    // reaching them — the host's Escape and Tab handling is on `window` in the
    // capture phase and has already run by this point.
    event.stopPropagation();

    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Not on the synthetic event; React does not surface it.
    if (event.nativeEvent.isComposing) return;

    // Space on a focused button is that button's own activation, and silently
    // turning "exit" into "next slide" is worse than losing one paging key.
    if (event.key === ' ' && event.target instanceof HTMLButtonElement) return;

    switch (event.key) {
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

  const label = slide?.title
    ? `Slide ${position + 1} of ${total}: ${slide.title}`
    : `Slide ${position + 1} of ${total}`;

  return (
    <div
      className="mdv-present"
      // Read by the print rule that strips chrome by attribute rather than by
      // class name. Restated in presentation.css, since the rule in viewer.css
      // is scoped to `#mdv-root` and cannot see the overlay layer's portal.
      data-mdv-chrome
      onKeyDown={handleKeyDown}
      // Neutralizes the document-level listeners other features attach — the
      // lightbox in particular, which would otherwise open an image viewer on
      // top of the deck. Its listener is on `document`; React's for this tree
      // is on `document.body`, one step earlier.
      onClick={(event) => event.stopPropagation()}
    >
      {/* Role, label and modality are on the host's overlay element, one level
          up. This is layout only. */}
      <div className="mdv-present-dialog">
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
              onClick={close}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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
