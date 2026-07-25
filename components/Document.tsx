import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';

import { clearExternalLinks, markExternalLinks } from '@/lib/links';

import './document.css';

/** How long a copy button or anchor stays in its confirmation state. */
const COPY_FEEDBACK_MS = 1600;

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.    */
/* -------------------------------------------------------------------------- */

const ICON = [
  '<svg class="mdv-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"',
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"',
  'stroke-linejoin="round" aria-hidden="true" focusable="false">',
].join(' ');

const ICON_COPY = `${ICON}<rect x="5.2" y="5.2" width="8.8" height="8.8" rx="1.4"/><path d="M10.8 5V3.4A1.4 1.4 0 0 0 9.4 2H3.4A1.4 1.4 0 0 0 2 3.4v6a1.4 1.4 0 0 0 1.4 1.4H5"/></svg>`;
const ICON_CHECK = `${ICON}<path d="m3 8.4 3.2 3.3L13 4.6"/></svg>`;
const ICON_FAIL = `${ICON}<circle cx="8" cy="8" r="6.1"/><path d="M8 4.9v3.6M8 10.8v.1"/></svg>`;
const ICON_LINK = `${ICON}<path d="M6.6 9.4a2.9 2.9 0 0 0 4.1 0l2.1-2.1a2.9 2.9 0 0 0-4.1-4.1l-1 1"/><path d="M9.4 6.6a2.9 2.9 0 0 0-4.1 0L3.2 8.7a2.9 2.9 0 0 0 4.1 4.1l1-1"/></svg>`;

/**
 * The document body, plus the three things layered over it: a copy button on
 * every code block, an anchor link on every heading, and the raw/rendered
 * toggle.
 *
 * The body is injected HTML, so React does not own a single node inside it.
 * That shapes everything below: the affordances are DOM nodes grafted on in one
 * pass per document, all of their clicks land on one delegated handler, and
 * their transient state lives in attributes rather than in React state. Nothing
 * here re-walks the document when the component re-renders.
 *
 * `showRaw` belongs to the shell; this component only reflects it and reports
 * the toggle back.
 */
export function Document({
  html,
  source,
  showRaw,
  externalLinks,
  onToggleRaw,
}: {
  html: string;
  source: string;
  showRaw: boolean;
  /** The `externalLinks` setting. Off attaches nothing and leaves no residue. */
  externalLinks: boolean;
  onToggleRaw: () => void;
}) {
  const bodyRef = useRef<HTMLElement | null>(null);
  const feedbackRef = useRef<{ control: HTMLElement; timer: number } | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState('');

  // A stable object keeps React from re-setting innerHTML — it compares the
  // string, but there is no reason to hand it a new wrapper every render.
  const markup = useMemo(() => ({ __html: html }), [html]);

  const clearFeedback = useCallback(() => {
    const pending = feedbackRef.current;
    if (!pending) return;

    clearTimeout(pending.timer);
    pending.control.removeAttribute('data-mdv-copied');
    feedbackRef.current = null;
  }, []);

  const showFeedback = useCallback(
    (control: HTMLElement, copied: boolean) => {
      // Only one control is ever in its confirmation state, so a second copy
      // resets the first rather than leaving two check marks on screen.
      clearFeedback();

      control.dataset.mdvCopied = copied ? 'yes' : 'no';
      setAnnouncement(copied ? 'Copied to clipboard' : 'Copy failed');

      feedbackRef.current = {
        control,
        timer: window.setTimeout(() => {
          control.removeAttribute('data-mdv-copied');
          feedbackRef.current = null;
          // Back to empty so an identical message a moment later still reads as
          // a change, which is the only way a live region announces it twice.
          setAnnouncement('');
        }, COPY_FEEDBACK_MS),
      };
    },
    [clearFeedback],
  );

  /**
   * One listener for every copy button and every anchor in the document. Per
   * control listeners would have to be attached — and detached — each time the
   * body is replaced, on nodes React is not tracking.
   */
  const handleBodyClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const origin = event.target;
      if (!(origin instanceof Element)) return;

      const control = origin.closest<HTMLElement>('.mdv-copy, .mdv-anchor');
      if (!control) return;

      // The anchor is a real link and keeps its default behaviour: the click
      // still moves the address bar to the section, which is half of what the
      // reader expects from it. `href` is already absolute.
      const text =
        control instanceof HTMLAnchorElement ? control.href : codeTextOf(control);

      void copyText(text).then((copied) => showFeedback(control, copied));
    },
    [showFeedback],
  );

  // After paint, once per document: a multi-MB README is on screen and
  // scrollable before any of this runs. Raw mode has no body to enhance.
  useEffect(() => {
    const body = bodyRef.current;
    if (body) enhance(body);

    // Part of the same pass rather than a second one: it is another attribute
    // write per matching element, decided from the URL alone — no request, and
    // nothing read back off the layout.
    if (body) {
      if (externalLinks) markExternalLinks(body, location.href);
      else clearExternalLinks(body);
    }

    // Replacing the body destroys the node holding the confirmation attribute,
    // which would otherwise leave a timer pointing at a detached element.
    return clearFeedback;
  }, [html, showRaw, externalLinks, clearFeedback]);

  return (
    // A single root, not a fragment: `.mdv > :not(nav)` in viewer.css grants
    // `flex: 1 1 auto` to every non-nav child of the shell, so top-level
    // siblings here would be laid out side by side in the flex row.
    <div className="mdv-doc">
      <div className="mdv-toolbar" data-mdv-chrome>
        <button
          type="button"
          className="mdv-tool"
          aria-pressed={showRaw}
          aria-label={showRaw ? 'Show rendered document' : 'Show raw markdown'}
          onClick={onToggleRaw}
        >
          <svg
            className="mdv-icon"
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            {showRaw ? (
              <path d="M3 3.4h10M3 6.6h10M3 9.8h7M3 13h5" />
            ) : (
              <>
                <path d="M5.6 4.8 2.4 8l3.2 3.2" />
                <path d="M10.4 4.8 13.6 8l-3.2 3.2" />
              </>
            )}
          </svg>
          Raw
        </button>
      </div>

      <div className="mdv-sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {/* Distinct keys, so switching views swaps the element instead of asking
          React to reconcile injected HTML against real children. */}
      {showRaw ? (
        <main key="raw" className="mdv-body">
          {/* Text child, never innerHTML: the source is untrusted and this view
              exists precisely to show it as characters. */}
          <pre className="mdv-raw">{source}</pre>
        </main>
      ) : (
        <main
          key="rendered"
          ref={bodyRef}
          className="mdv-body"
          onClick={handleBodyClick}
          dangerouslySetInnerHTML={markup}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Grafting the affordances on                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Built once and cloned per block. Parsing the same markup string for every
 * code block in a large document is the expensive way to do this; cloneNode
 * skips the parser entirely.
 */
let templates: { code: HTMLElement; anchor: HTMLAnchorElement } | null = null;

function getTemplates() {
  if (templates) return templates;

  const code = document.createElement('div');
  code.className = 'mdv-code';
  code.innerHTML =
    `<button type="button" class="mdv-copy">` +
    `<span class="mdv-face mdv-face-idle">${ICON_COPY}Copy</span>` +
    `<span class="mdv-face mdv-face-done">${ICON_CHECK}Copied</span>` +
    `<span class="mdv-face mdv-face-fail">${ICON_FAIL}Failed</span>` +
    `</button>`;

  const anchor = document.createElement('a');
  anchor.className = 'mdv-anchor';
  anchor.setAttribute('aria-label', 'Copy link to this section');
  anchor.innerHTML =
    `<span class="mdv-face mdv-face-idle">${ICON_LINK}</span>` +
    `<span class="mdv-face mdv-face-done">${ICON_CHECK}</span>` +
    `<span class="mdv-face mdv-face-fail">${ICON_FAIL}</span>`;

  templates = { code, anchor };
  return templates;
}

/**
 * The single pass over a rendered document.
 *
 * One query, one iteration, and the work after that is proportional to the
 * number of code blocks and headings rather than to the number of nodes — a
 * 5 MB README has a lot of paragraphs and not many of either. The NodeList is
 * static, so moving elements while iterating it is safe.
 *
 * Nothing is read back off the layout, so the whole pass is a batch of
 * mutations the browser resolves in one go.
 */
function enhance(body: HTMLElement) {
  const { code, anchor } = getTemplates();
  const targets = body.querySelectorAll<HTMLElement>(
    'pre, h1[id], h2[id], h3[id], h4[id]',
  );

  targets.forEach((target) => {
    if (target instanceof HTMLPreElement) {
      if (target.parentElement?.classList.contains('mdv-code')) return;

      const wrapper = code.cloneNode(true) as HTMLElement;
      const button = wrapper.firstElementChild as HTMLButtonElement;
      // Highlighting puts the language on the <code>; naming it turns a page of
      // identical "Copy code" buttons into something a screen reader can tell
      // apart.
      const language = /(?:^|\s)language-([\w+#.-]+)/.exec(
        target.firstElementChild?.className ?? '',
      )?.[1];
      button.setAttribute(
        'aria-label',
        language ? `Copy ${language} code` : 'Copy code',
      );

      target.replaceWith(wrapper);
      // Button first in source order, so it is announced and reached before the
      // block it applies to rather than after a screenful of code.
      wrapper.append(target);
      return;
    }

    if (target.lastElementChild?.classList.contains('mdv-anchor')) return;

    const link = anchor.cloneNode(true) as HTMLAnchorElement;
    // setAttribute rather than string-built markup: an id can come from raw
    // HTML in the source, and it is not this function's job to escape it.
    link.setAttribute('href', `#${target.id}`);
    target.append(link);
  });
}

/** The code inside a block, without the copy button's own label. */
function codeTextOf(button: HTMLElement): string {
  const pre = button.parentElement?.querySelector('pre');
  if (!pre) return '';

  // The <code> is the payload; anything a future revision adds around it —
  // line numbers, a filename header — stays out of the clipboard by default.
  return (pre.querySelector('code') ?? pre).textContent ?? '';
}

/* -------------------------------------------------------------------------- */
/* Clipboard                                                                   */
/* -------------------------------------------------------------------------- */

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
