/**
 * A copy button on every code block.
 *
 * Half of what used to be `components/Document.tsx`'s single enhancement pass,
 * now a feature that can be turned off on its own. Nothing about the behaviour
 * moved: the same wrapper, the same cloned template, the same delegated click,
 * the same confirmation state kept in an attribute rather than in React.
 *
 * What did move is the plumbing. There is no `useEffect` keyed on `html`, no
 * `bodyRef`, and no second copy of "find the body" — `ctx.document.enhance`
 * runs the pass once per document, batched with every other plugin's, and runs
 * the teardown before each re-run. The teardown is what makes the pass exactly
 * reversible: it unwraps the blocks *it* wrapped rather than querying for
 * `.mdv-code` later and hoping the answer is the same set.
 *
 * Split from `index.ts` so the logic is reachable by the bare test runner; this
 * plugin has no JSX, so the seam is a plain re-export rather than a factory
 * taking components.
 */

import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';

import { createClipboard } from '../../lib/clipboard.ts';

/* Icons come from the one module that holds them — inline SVG still, because
   the extension never loads a resource of any kind, but built once (D9). */
import { ICON_CHECK, ICON_COPY, ICON_FAIL } from '../../design/icons.ts';

export const CODE_COPY_PLUGIN_ID = 'code-copy';

/**
 * Built once and cloned per block. Parsing the same markup string for every
 * code block in a large document is the expensive way to do this; cloneNode
 * skips the parser entirely.
 */
let template: HTMLElement | null = null;

function getTemplate(): HTMLElement {
  if (template) return template;

  const wrapper = document.createElement('div');
  wrapper.className = 'mdv-code';
  wrapper.innerHTML =
    `<button type="button" class="mdv-copy">` +
    `<span class="mdv-face mdv-face-idle">${ICON_COPY}Copy</span>` +
    `<span class="mdv-face mdv-face-done">${ICON_CHECK}Copied</span>` +
    `<span class="mdv-face mdv-face-fail">${ICON_FAIL}Failed</span>` +
    `</button>`;

  template = wrapper;
  return template;
}

export function createCodeCopyPlugin(): Plugin {
  return {
    id: CODE_COPY_PLUGIN_ID,
    name: 'Copy code blocks',
    description: 'A copy button on every code block in the document.',
    apiVersion: PLUGIN_API_VERSION,
    // No setting of its own: whether the button exists is this plugin's enabled
    // state and nothing else, which is one concept rather than two that can
    // disagree.
    enabledByDefault: true,

    setup(ctx) {
      const clipboard = createClipboard();

      const stop = ctx.document.enhance((body) => {
        // The raw view is a different `<main>` holding one `<pre>` — the source
        // itself — and wrapping that in a copy button would offer to copy the
        // document to the clipboard.
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

/**
 * The pass, and its exact inverse.
 *
 * One query and one iteration, with the work after that proportional to the
 * number of code blocks rather than to the number of nodes — a 5 MB README has
 * a lot of paragraphs and not many code blocks. The NodeList is static, so
 * moving elements while iterating it is safe, and nothing is read back off the
 * layout, so the whole pass is one batch of mutations.
 */
function attach(body: HTMLElement, clipboard: ReturnType<typeof createClipboard>): Teardown {
  const wrappers: HTMLElement[] = [];

  body.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('mdv-code')) return;

    const wrapper = getTemplate().cloneNode(true) as HTMLElement;
    const button = wrapper.firstElementChild as HTMLButtonElement;
    // Highlighting puts the language on the <code>; naming it turns a page of
    // identical "Copy code" buttons into something a screen reader can tell
    // apart.
    const language = /(?:^|\s)language-([\w+#.-]+)/.exec(
      pre.firstElementChild?.className ?? '',
    )?.[1];
    button.setAttribute('aria-label', language ? `Copy ${language} code` : 'Copy code');

    pre.replaceWith(wrapper);
    // Button first in source order, so it is announced and reached before the
    // block it applies to rather than after a screenful of code.
    wrapper.append(pre);
    wrappers.push(wrapper);
  });

  /**
   * One listener for every copy button in the document. Per-control listeners
   * would have to be attached — and detached — each time the body is replaced,
   * on nodes React is not tracking.
   *
   * It lives on the body rather than on `document` so it unbinds with the pass:
   * the body is the element the pass was handed, and a document-level listener
   * would outlive the document it was registered for.
   */
  const onClick = (event: MouseEvent) => {
    const origin = event.target;
    if (!(origin instanceof Element)) return;

    const control = origin.closest<HTMLElement>('.mdv-copy');
    if (!control) return;

    clipboard.copy(control, codeTextOf(control));
  };

  body.addEventListener('click', onClick);

  return () => {
    body.removeEventListener('click', onClick);
    // Replacing the body destroys the node holding the confirmation attribute,
    // which would otherwise leave a timer pointing at a detached element.
    clipboard.clear();

    for (const wrapper of wrappers) {
      const pre = wrapper.querySelector('pre');
      // Put the block back exactly where the wrapper stood, rather than
      // removing the wrapper and hoping something else re-homes it.
      if (pre) wrapper.replaceWith(pre);
      else wrapper.remove();
    }
  };
}

/** The code inside a block, without the copy button's own label. */
function codeTextOf(button: HTMLElement): string {
  const pre = button.parentElement?.querySelector('pre');
  if (!pre) return '';

  // The <code> is the payload; anything a future revision adds around it —
  // line numbers, a filename header — stays out of the clipboard by default.
  return (pre.querySelector('code') ?? pre).textContent ?? '';
}
