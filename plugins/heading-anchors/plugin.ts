/**
 * A link-to-this-section anchor on every heading.
 *
 * The other half of `components/Document.tsx`'s single enhancement pass. It was
 * never really the same feature as the copy buttons — one is about code, the
 * other about navigation — and sharing a pass is what made them impossible to
 * turn off separately. They now share nothing but a technique.
 *
 * The anchor stays a real link and keeps its default behaviour: the click still
 * moves the address bar to the section, which is half of what the reader
 * expects from it. Copying the URL is the other half.
 *
 * `heading-fold` prepends its control to the same headings and reads
 * `lastElementChild` to decide whether the anchor is already there — so the
 * anchor is appended, never prepended, exactly as before.
 */

import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';

import { createClipboard } from '../../lib/clipboard.ts';

/* One module owns the glyphs and their size; see D9. */
import { ICON_CHECK, ICON_FAIL, ICON_LINK } from '../../design/icons.ts';

export const HEADING_ANCHORS_PLUGIN_ID = 'heading-anchors';

/** The headings that get one. h5 and h6 are section labels, not destinations. */
const HEADINGS = 'h1[id], h2[id], h3[id], h4[id]';

/** Built once and cloned per heading, for the reason `code-copy` gives. */
let template: HTMLAnchorElement | null = null;

function getTemplate(): HTMLAnchorElement {
  if (template) return template;

  const anchor = document.createElement('a');
  anchor.className = 'mdv-anchor';
  anchor.setAttribute('aria-label', 'Copy link to this section');
  anchor.innerHTML =
    `<span class="mdv-face mdv-face-idle">${ICON_LINK}</span>` +
    `<span class="mdv-face mdv-face-done">${ICON_CHECK}</span>` +
    `<span class="mdv-face mdv-face-fail">${ICON_FAIL}</span>`;

  template = anchor;
  return template;
}

export function createHeadingAnchorsPlugin(): Plugin {
  return {
    id: HEADING_ANCHORS_PLUGIN_ID,
    name: 'Heading anchors',
    description: 'A link to copy on every heading, for pointing someone at a section.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,

    setup(ctx) {
      const clipboard = createClipboard();

      const stop = ctx.document.enhance((body) => {
        // The raw view has no headings to anchor — it is one `<pre>`.
        if (ctx.document.isRaw) return;
        return attach(body, clipboard);
      });

      return () => {
        stop();
        clipboard.dispose();
      };
    },
  };
}

/** The pass, and its exact inverse: the anchors it added, removed. */
function attach(body: HTMLElement, clipboard: ReturnType<typeof createClipboard>): Teardown {
  const anchors: HTMLAnchorElement[] = [];

  body.querySelectorAll<HTMLElement>(HEADINGS).forEach((heading) => {
    if (heading.lastElementChild?.classList.contains('mdv-anchor')) return;

    const link = getTemplate().cloneNode(true) as HTMLAnchorElement;
    // setAttribute rather than string-built markup: an id can come from raw
    // HTML in the source, and it is not this function's job to escape it.
    link.setAttribute('href', `#${heading.id}`);
    heading.append(link);
    anchors.push(link);
  });

  const onClick = (event: MouseEvent) => {
    const origin = event.target;
    if (!(origin instanceof Element)) return;

    const control = origin.closest<HTMLElement>('.mdv-anchor');
    if (!(control instanceof HTMLAnchorElement)) return;

    // Not prevented: the link still navigates to the section, and `href` is
    // already absolute by the time it is read back off the element.
    clipboard.copy(control, control.href);
  };

  body.addEventListener('click', onClick);

  return () => {
    body.removeEventListener('click', onClick);
    clipboard.clear();
    for (const anchor of anchors) anchor.remove();
  };
}
