/**
 * Math.
 *
 * By the time this runs the formulae are already in the page: `lib/markdown.ts`
 * turns `$inline$` and `$$block$$` into KaTeX markup during the parse, which is
 * the only stage that can tell a `$` in prose from a `$` inside a code span.
 * Nothing here renders anything.
 *
 * What the parse cannot carry is the other half of KaTeX — its stylesheet and
 * its twenty font files. Those are why this is an add-on at all: the service
 * worker injects `assets/katex-theme.css` alongside this script (`ADDONS` in
 * lib/config.ts), and that stylesheet points at `fonts/*.woff2` packaged in the
 * extension, which have to be listed in `web_accessible_resources` or the page
 * is not allowed to load them.
 *
 * `entrypoints/katex-theme.css` and `public/fonts/` are both generated from the
 * installed katex package by `scripts/build-katex-theme.mjs` rather than
 * hand-edited — that file explains the three transformations and why each one
 * is needed. Rerun it when katex is upgraded.
 *
 * That leaves this file the two jobs CSS cannot do, both of which need layout:
 * making an over-wide equation reachable from the keyboard, and noticing that
 * the fonts never arrived.
 *
 * A second injection re-runs the whole file with a fresh module scope, so
 * "already done" is recorded on the DOM rather than in a module-level flag.
 */

import { MATH_CLASS, VIEWER_ROOT_ID } from '@/lib/config';

/** KaTeX's own wrapper around a `$$…$$` formula. */
const DISPLAY_SELECTOR = `.${MATH_CLASS}-display`;

/** On <html>, so the observers below are wired exactly once per document. */
const INSTALLED_KEY = 'mdvKatexAddon';

/**
 * Also on <html>: 'ready' or 'missing'.
 *
 * Purely diagnostic, and deliberately so. A missing `web_accessible_resources`
 * entry does not break math visibly — the fallback families in katex-addon.css
 * keep every formula legible — it just quietly renders it in the wrong
 * typeface, which is exactly the kind of failure that ships. This makes it
 * something you can see in the inspector and in the console.
 */
const FONTS_KEY = 'mdvKatexFonts';

/** One face per file family we would notice the absence of. */
const PROBE_FONTS = ['KaTeX_Main', 'KaTeX_Math', 'KaTeX_Size1'];

export default defineUnlistedScript(() => {
  const root = document.getElementById(VIEWER_ROOT_ID);
  // No viewer means nothing asked for this. The renderer is the only caller.
  if (!root) return;

  markOverflowing(root);

  const html = document.documentElement;
  if (html.dataset[INSTALLED_KEY]) return;
  html.dataset[INSTALLED_KEY] = 'on';

  void checkFonts();
  watch(root);
});

/* -------------------------------------------------------------------------- */
/* Over-wide equations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A display equation is one long unbreakable line and the measure is not, so
 * katex-addon.css lets it scroll inside its own box. A scroll box that nothing
 * can focus is unreachable without a mouse, which is why the ones that actually
 * overflow are given a tab stop and a name.
 *
 * It has to be measured rather than guessed, and re-measured whenever the
 * width changes — hence the observers below rather than a one-off pass.
 */
function markOverflowing(root: HTMLElement): void {
  for (const display of root.querySelectorAll<HTMLElement>(DISPLAY_SELECTOR)) {
    // A pixel of slack: sub-pixel layout routinely reports scrollWidth one
    // larger than clientWidth for content that visibly fits.
    if (display.scrollWidth - display.clientWidth > 1) {
      display.setAttribute('tabindex', '0');
      display.setAttribute('role', 'region');
      display.setAttribute('aria-label', 'Scrollable equation');
    } else {
      // Widening the window can make an equation fit again, and a tab stop on
      // something that no longer scrolls is just an empty stop.
      display.removeAttribute('tabindex');
      display.removeAttribute('role');
      display.removeAttribute('aria-label');
    }
  }
}

/**
 * Both events that can change the answer: the viewer replacing its body, and
 * the measure changing under it — a window resize, or the content-width and
 * font-size settings, which is why this watches the element rather than the
 * window.
 */
function watch(root: HTMLElement): void {
  let scheduled = false;

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      markOverflowing(root);
    });
  };

  // childList only: the pass sets attributes, and observing those would make it
  // retrigger itself.
  new MutationObserver(schedule).observe(root, {
    childList: true,
    subtree: true,
  });

  new ResizeObserver(schedule).observe(root);
}

/* -------------------------------------------------------------------------- */
/* Fonts                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `document.fonts.load` resolves against the faces declared by the stylesheet
 * we just injected, and those name extension-local files — this asks the
 * browser to open `chrome-extension://…/fonts/…`, never the network.
 */
async function checkFonts(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts) return;

  try {
    await Promise.all(PROBE_FONTS.map((family) => fonts.load(`1em ${family}`)));
  } catch {
    // A face that cannot load rejects here on some engines and merely fails
    // `check` on others. Either way the verdict below is the one that counts.
  }

  const ready = PROBE_FONTS.every((family) => fonts.check(`1em ${family}`));
  document.documentElement.dataset[FONTS_KEY] = ready ? 'ready' : 'missing';

  if (!ready) {
    console.warn(
      '[markdown-viewer] KaTeX fonts did not load; math will render in a ' +
        'fallback face. Check that fonts/*.woff2 is listed in ' +
        'web_accessible_resources.',
    );
  }
}
