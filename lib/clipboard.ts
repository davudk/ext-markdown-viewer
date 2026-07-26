/**
 * Copying text, and the one-confirmation-at-a-time affordance around it.
 *
 * Shared because two plugins need it and neither may import the other: code
 * blocks and heading anchors are separately disableable, so a capability would
 * be wrong too — heading anchors would stop copying whenever code-copy was off.
 * It lived duplicated in both plugin folders until this file existed.
 *
 * The async clipboard API is tried first and the off-screen textarea is the
 * fallback, which matters on `file://` where the async API is often absent or
 * rejects outright.
 */

/** How long a control stays in its confirmation state. */
const FEEDBACK_MS = 1600;

export interface Clipboard {
  /** Copies, then flips the control into its confirmation state. */
  copy(control: HTMLElement, text: string): void;
  /** Drops any pending confirmation — used when the body is replaced. */
  clear(): void;
  /** Removes the live region. Returned as the plugin's teardown. */
  dispose(): void;
}

/**
 * A clipboard bound to one live region.
 *
 * The live region is appended to `document.body` rather than contributed to a
 * region: it is a `position: absolute` screen-reader-only node with no visual
 * presence, and the imperative mount path would wrap it in a plain `<div>` that
 * `.mdv > :not(nav)` in viewer.css would then grant `flex: 1 1 auto` — a second
 * document column, to announce "Copied".
 */
export function createClipboard(): Clipboard {
  let region: HTMLElement | null = null;
  let pending: { control: HTMLElement; timer: number } | null = null;

  const liveRegion = (): HTMLElement => {
    if (region?.isConnected) return region;

    region = document.createElement('div');
    region.className = 'mdv-sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    // Read by the print rule in viewer.css and skipped by Search, which is the
    // rule for every piece of screen-only chrome.
    region.setAttribute('data-mdv-chrome', '');
    document.body.append(region);
    return region;
  };

  const announce = (message: string) => {
    liveRegion().textContent = message;
  };

  const clear = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.control.removeAttribute('data-mdv-copied');
    pending = null;
  };

  return {
    copy(control, text) {
      void copyText(text).then((copied) => {
        // Only one control is ever in its confirmation state, so a second copy
        // resets the first rather than leaving two check marks on screen.
        clear();

        control.dataset.mdvCopied = copied ? 'yes' : 'no';
        announce(copied ? 'Copied to clipboard' : 'Copy failed');

        pending = {
          control,
          timer: setTimeout(() => {
            control.removeAttribute('data-mdv-copied');
            pending = null;
            // Back to empty so an identical message a moment later still reads
            // as a change, which is the only way a live region says it twice.
            announce('');
          }, FEEDBACK_MS) as unknown as number,
        };
      });
    },

    clear,

    dispose() {
      clear();
      region?.remove();
      region = null;
    },
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through. On file:// — a primary case for this extension — the async
    // clipboard API is frequently missing or rejects outright, and the
    // deprecated path below still works there.
  }

  return copyTextLegacy(text);
}

function copyTextLegacy(text: string): boolean {
  const previousFocus = document.activeElement;
  const selection = document.getSelection();
  const previousRange =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  // Off-screen but rendered: `display: none` or `visibility: hidden` would make
  // the selection uncopyable, which is the whole point of the element.
  scratch.style.cssText =
    'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;';
  document.body.append(scratch);

  let copied = false;
  try {
    scratch.select();
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }

  scratch.remove();

  // Selecting the scratch element stole both the selection and the focus ring;
  // put the reader back where they were.
  if (previousRange && selection) {
    selection.removeAllRanges();
    selection.addRange(previousRange);
  }
  if (previousFocus instanceof HTMLElement) previousFocus.focus();

  return copied;
}
