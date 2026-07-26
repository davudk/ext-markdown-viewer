/**
 * Math.
 *
 * `lib/markdown.ts` tokenizes `$inline$` and `$$block$$` during the parse —
 * that is the only stage that can tell a `$` in prose from a `$` inside a code
 * span — but it no longer *renders* them. Each formula reaches the page as a
 * placeholder carrying its own TeX as text, and this add-on is what turns those
 * into typeset math. Rendering moved here because KaTeX and its twenty font
 * files are a quarter of a megabyte that a README with no math should not pay:
 * the service worker injects this script and `assets/katex-theme.css` together
 * (`ADDONS` in lib/config.ts) only for documents that actually contain a
 * formula.
 *
 * `entrypoints/katex-theme.css` and `public/fonts/` are both generated from the
 * installed katex package by `scripts/build-katex-theme.mjs` rather than
 * hand-edited — that file explains the three transformations and why each one
 * is needed. Rerun it when katex is upgraded. The stylesheet points at
 * `fonts/*.woff2` packaged in the extension, which have to be listed in
 * `web_accessible_resources` or the page is not allowed to load them.
 *
 * Everything below runs in the page against a document that is already on
 * screen, and owns no part of the React tree. Two things follow from being
 * injected rather than imported: a second injection re-runs the whole file with
 * a fresh module scope, so "already done" is recorded on the DOM; and the
 * viewer can rebuild its body underneath us at any time, so every pass is
 * written to be repeatable rather than one-shot.
 *
 * What KaTeX produces is inserted into the DOM directly, which is past the
 * point where the pipeline's DOMPurify could see it — hence the second
 * sanitizer pass here.
 */

import DOMPurify, { type Config as PurifyConfig } from 'dompurify';
import katex from 'katex';

import {
  KATEX_OPTIONS,
  MATH_CLASS,
  MATH_DISPLAY_CLASS,
  MATH_PLACEHOLDER_CLASS,
  VIEWER_ROOT_ID,
} from '@/lib/config';

/** What the pipeline left for us. */
const PLACEHOLDER_SELECTOR = `.${MATH_PLACEHOLDER_CLASS}`;

/** KaTeX's own wrapper around a `$$…$$` formula. */
const DISPLAY_SELECTOR = `.${MATH_CLASS}-display`;

/** On a placeholder once it has been dealt with: 'ok' or 'error'. */
const FORMULA_KEY = 'mdvMath';
const FORMULA_ATTR = attributeName(FORMULA_KEY);

/** On <html>, so the observers below are wired exactly once per document. */
const INSTALLED_KEY = 'mdvKatexAddon';

/**
 * Also on <html>: 'ready' or 'missing'.
 *
 * Purely diagnostic, and deliberately so. A missing `web_accessible_resources`
 * entry does not break math visibly — the fallback families in the theme
 * stylesheet keep every formula legible — it just quietly renders it in the
 * wrong typeface, which is exactly the kind of failure that ships. This makes it
 * something you can see in the inspector and in the console.
 */
const FONTS_KEY = 'mdvKatexFonts';

/** One face per file family we would notice the absence of. */
const PROBE_FONTS = ['KaTeX_Main', 'KaTeX_Math', 'KaTeX_Size1'];

/**
 * Every font file KaTeX ships, by basename.
 *
 * The family and the variant are both in the name — `KaTeX_Main-BoldItalic` is
 * family `KaTeX_Main`, weight 700, style italic — so the table is the list of
 * files and nothing else, and adding a face is adding a string.
 */
const FONT_FILES = [
  'AMS-Regular',
  'Caligraphic-Bold',
  'Caligraphic-Regular',
  'Fraktur-Bold',
  'Fraktur-Regular',
  'Main-Bold',
  'Main-BoldItalic',
  'Main-Italic',
  'Main-Regular',
  'Math-BoldItalic',
  'Math-Italic',
  'SansSerif-Bold',
  'SansSerif-Italic',
  'SansSerif-Regular',
  'Script-Regular',
  'Size1-Regular',
  'Size2-Regular',
  'Size3-Regular',
  'Size4-Regular',
  'Typewriter-Regular',
] as const;

/**
 * What a rendered formula is allowed to be.
 *
 * KaTeX writes both halves of every formula — the `<math>` tree screen readers
 * read and the `<span>`/`<svg>` stack sighted readers see — so all three
 * profiles are on. `\sqrt{x}` loses its surd entirely without the SVG one.
 *
 * `semantics` and `annotation` are the deliberate hole, reopened by hand for
 * the same reason the pipeline's config used to reopen it: DOMPurify refuses
 * the family because `<annotation-xml>` can carry HTML into the MathML
 * namespace, but its two plain siblings cannot, and dropping them makes
 * `KEEP_CONTENT` hoist the raw TeX into `<math>` as loose text that every
 * screen reader then reads aloud. It is also where `lib/export.ts` recovers the
 * TeX from for a DOCX. `annotation-xml` stays disallowed.
 *
 * The input is TeX out of an untrusted .md. KaTeX with `trust: false` emits no
 * script and no URL — this pass is what makes that a property of the page
 * rather than a property of a library version.
 */
const MATH_PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['semantics', 'annotation'],
  ALLOW_DATA_ATTR: false,
  // KaTeX positions its glyph stack with `style` attributes, which are kept.
  // A `<style>` element is a different thing: it would reach outside the
  // formula and could restyle the viewer's own chrome.
  FORBID_TAGS: ['style'],
};

/**
 * The one case where inline delimiters still mean display math. `$\begin{align}
 * …\end{align}$` is an environment that lays itself out in rows, and KaTeX
 * refuses to typeset it in inline mode — the plugin's own renderer made the same
 * exception, and dropping it would turn those formulae into red error text.
 */
const DISPLAY_ENVIRONMENTS = /\\begin\{(align|equation|gather|cd|alignat)\}/i;

let rendering = false;

export default defineUnlistedScript(() => {
  const root = document.getElementById(VIEWER_ROOT_ID);
  // No viewer means nothing asked for this. The renderer is the only caller.
  if (!root) return;

  render(root);
  markOverflowing(root);

  const html = document.documentElement;
  if (html.dataset[INSTALLED_KEY]) return;
  html.dataset[INSTALLED_KEY] = 'on';

  installFonts();
  void checkFonts();
  watch(root);
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function render(root: HTMLElement): void {
  // A formula already dealt with keeps its marker, and that is the whole of the
  // idempotence guard: a second injection, or a re-render after the viewer
  // rebuilt its body, only ever picks up what is new.
  const pending = root.querySelectorAll<HTMLElement>(
    `${PLACEHOLDER_SELECTOR}:not([${FORMULA_ATTR}])`,
  );
  if (pending.length === 0) return;

  rendering = true;
  try {
    for (const placeholder of pending) renderFormula(placeholder);
  } finally {
    rendering = false;
  }
}

function renderFormula(placeholder: HTMLElement): void {
  // The TeX is the placeholder's text — see MATH_PLACEHOLDER_CLASS in
  // config.ts for why it travels that way rather than in an attribute.
  const tex = placeholder.textContent ?? '';

  try {
    const displayMode =
      placeholder.classList.contains(MATH_DISPLAY_CLASS) ||
      DISPLAY_ENVIRONMENTS.test(tex);

    const fragment = DOMPurify.sanitize(
      katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode }),
      { ...MATH_PURIFY_CONFIG, RETURN_DOM_FRAGMENT: true },
    );

    // Nothing recognisable survived. Better to keep the source visible than to
    // leave a blank where a formula should be.
    if (!fragment.querySelector(`.${MATH_CLASS}`)) {
      throw new Error('the formula did not survive sanitization');
    }

    placeholder.replaceChildren(fragment);
    placeholder.dataset[FORMULA_KEY] = 'ok';
  } catch (error) {
    // KATEX_OPTIONS sets `throwOnError: false`, so a malformed formula normally
    // arrives here as legible red markup rather than an exception. Reaching this
    // branch means something worse happened — and the TeX is still sitting in
    // the placeholder untouched, which is the readable outcome.
    placeholder.dataset[FORMULA_KEY] = 'error';
    console.warn('[markdown-viewer] formula not rendered:', error);
  }
}

/* -------------------------------------------------------------------------- */
/* Over-wide equations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A display equation is one long unbreakable line and the measure is not, so
 * the theme stylesheet lets it scroll inside its own box. A scroll box that
 * nothing can focus is unreachable without a mouse, which is why the ones that
 * actually overflow are given a tab stop and a name.
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
 * Both events that can change the answer: the viewer replacing its body — which
 * brings unrendered placeholders back with it — and the measure changing under
 * it, a window resize or the content-width and font-size settings, which is why
 * this watches the element rather than the window.
 */
function watch(root: HTMLElement): void {
  let scheduled = false;

  const schedule = () => {
    // Our own replacements are mutations too. Ignoring them while a pass is in
    // flight is what keeps this from feeding itself.
    if (scheduled || rendering) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render(root);
      markOverflowing(root);
    });
  };

  // childList only: the passes above set attributes, and observing those would
  // make them retrigger themselves.
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
 * Registers KaTeX's faces against absolute extension URLs.
 *
 * The theme stylesheet declares them already, with `url(../fonts/…)` — and a
 * relative URL is only as good as the base it is resolved against. That
 * stylesheet arrives through `chrome.scripting.insertCSS`, which is to say it
 * is applied to a document whose own address is some .md file on the web, and a
 * relative reference out of it is not reliably rooted at the extension. When it
 * is not, all twenty faces fail to fetch, `document.fonts.check` says so, and
 * the warning below fires while every formula silently renders in Times.
 *
 * `chrome.runtime.getURL` has no such ambiguity: it returns the absolute
 * `chrome-extension://<id>/fonts/…` address, which is the file the manifest
 * lists in `web_accessible_resources` and which resolves the same from any
 * page. Registering here is additive — a face already loaded by the stylesheet
 * is simply satisfied twice, and the browser does not fetch it again.
 *
 * Never a network request: every URL is extension-local by construction.
 */
function installFonts(): void {
  // `FontFace` and `document.fonts` are both old enough not to need a guard in
  // Chrome; the try is for `getURL`, which is absent if this ever runs anywhere
  // but an extension context — in which case the stylesheet's own faces stand.
  try {
    for (const file of FONT_FILES) {
      const [family, variant = 'Regular'] = file.split('-');
      const face = new FontFace(
        `KaTeX_${family}`,
        `url(${chrome.runtime.getURL(`fonts/KaTeX_${file}.woff2`)}) format("woff2")`,
        {
          weight: variant.startsWith('Bold') ? '700' : '400',
          style: variant.endsWith('Italic') ? 'italic' : 'normal',
          display: 'swap',
        },
      );
      document.fonts.add(face);
    }
  } catch {
    // A face that will not construct costs its own typeface and nothing else.
  }
}

/**
 * `document.fonts.load` resolves against the faces registered above and those
 * declared by the stylesheet — both name extension-local files, so this asks
 * the browser to open `chrome-extension://…/fonts/…`, never the network.
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

/** `mdvMath` → `data-mdv-math`. Dataset spellings are what config.ts publishes. */
function attributeName(datasetKey: string): string {
  return `data-${datasetKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}
