/**
 * Mermaid diagrams.
 *
 * Injected on demand by the service worker (`ADDONS` in lib/config.ts) into the
 * documents that actually contain ```mermaid blocks, because mermaid is larger
 * than the rest of the extension put together and most markdown has no diagrams
 * in it at all. So this runs in the page, against a document that is already on
 * screen, and owns no part of the React tree — it finds the blocks the markdown
 * pipeline deliberately left alone and swaps each one for a drawing.
 *
 * Two things follow from being injected rather than imported. A second
 * injection re-runs the whole file with a fresh module scope, so "already done"
 * has to be recorded on the DOM; and the document can be rebuilt underneath us
 * at any time, so the pass below is written to be repeatable rather than
 * one-shot.
 *
 * The input is a code block out of an arbitrary .md file. Everything mermaid
 * produces from it is treated as hostile.
 */

import DOMPurify, { type Config as PurifyConfig } from 'dompurify';
import mermaid, { type MermaidConfig } from 'mermaid';

import {
  MERMAID_LANGUAGE,
  VIEWER_ROOT_ID,
  VIEWER_THEME_DATASET_KEY,
} from '@/lib/config';

/** The blocks `lib/markdown.ts` passes through unhighlighted for us. */
const BLOCK_SELECTOR = `pre > code.language-${MERMAID_LANGUAGE}`;

/** On the <figure> that takes a block's place: 'ok' or 'error'. */
const FIGURE_KEY = 'mdvMermaid';
const FIGURE_ATTR = attributeName(FIGURE_KEY);

/** On <html>, so the observers below are wired exactly once per document. */
const INSTALLED_KEY = 'mdvMermaidAddon';

/**
 * What a rendered diagram is allowed to be.
 *
 * The SVG profile rather than the HTML one — they are disjoint allowlists, and
 * `USE_PROFILES: { html: true }` would delete the entire drawing. `svgFilters`
 * comes with it because mermaid's drop shadows are filter primitives.
 *
 * What that profile already refuses is the point of using it: <script>, event
 * handlers, <use> (same-origin document leaks), and <foreignObject>, which is
 * the standard way to smuggle HTML into the SVG namespace. `htmlLabels: false`
 * below means mermaid never emits one to begin with.
 *
 * Only two things are added to it. <image> is dropped because it is the one
 * remaining element in the profile that can name a remote file, and this
 * extension makes no requests. `role` is restored because the SVG profile does
 * not carry it and mermaid uses it to tell assistive technology that the thing
 * is a diagram.
 */
const SVG_PURIFY_CONFIG: PurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_ATTR: ['role'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['image'],
};

/**
 * `url(#arrowhead)` points inside the same SVG and is how mermaid draws every
 * arrow; anything else in a `url()` — and any `@import` — names a resource
 * somewhere else, which is the one thing this extension never does.
 */
const REMOTE_CSS = /@import[^;}]*;?|url\(\s*(?!['"]?#)[^)]*\)/gi;

let counter = 0;
let rendering = false;

export default defineUnlistedScript(() => {
  const root = document.getElementById(VIEWER_ROOT_ID);
  // No viewer means nothing asked for this and there are no blocks of ours to
  // find. The renderer is the only legitimate caller.
  if (!root) return;

  void render(root);

  const html = document.documentElement;
  if (html.dataset[INSTALLED_KEY]) return;
  html.dataset[INSTALLED_KEY] = 'on';

  watchTheme(root);
  watchDocument(root);
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

async function render(root: HTMLElement): Promise<void> {
  if (rendering) return;

  const blocks = [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter(
    // A diagram we have already drawn keeps its source as a hidden <pre>, which
    // matches the same selector. This is the whole of the idempotence guard.
    (code) => !code.closest(`[${FIGURE_ATTR}]`),
  );
  if (blocks.length === 0) return;

  rendering = true;
  try {
    mermaid.initialize(mermaidConfig());
    // Strictly one at a time. `mermaid.render` clears the staging element it is
    // handed and parks its working nodes on ids derived from the one it was
    // passed, so overlapping calls read each other's measurements.
    for (const code of blocks) await renderBlock(code);
  } finally {
    rendering = false;
  }
}

async function renderBlock(code: HTMLElement): Promise<void> {
  const pre = code.closest('pre');
  if (!pre) return;

  const figure = document.createElement('figure');
  figure.className = 'mdv-mermaid';
  // This add-on ships no stylesheet, so its handful of rules are set inline. A
  // <figure> arrives with 40px of UA side margin, which would indent every
  // diagram out of line with the rest of the document.
  figure.style.cssText = 'margin:0 0 1.15em;max-width:100%;overflow-x:auto;';

  // Mermaid sizes a diagram by measuring its labels, and getBBox reports zeroes
  // for anything the browser has not laid out — which rules out `display:none`
  // and `visibility:hidden` both. Staging it beside the block it replaces gets
  // it laid out *and* inheriting the same typography, so what mermaid measures
  // is what the reader ends up looking at.
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px;';
  pre.before(stage);

  try {
    const { svg } = await mermaid.render(
      `mdv-mermaid-${(counter += 1)}`,
      code.textContent ?? '',
      stage,
    );

    figure.append(sanitizeSvg(svg));
    figure.dataset[FIGURE_KEY] = 'ok';
    // The fenced source travels with the diagram rather than being replaced by
    // it: the copy button reaches into this <pre>, and so does an export.
    pre.style.display = 'none';
  } catch (error) {
    // A diagram that will not parse is common — it is a code block someone is
    // still writing. It must cost that one block and nothing else: no blank
    // space where a figure should be, and no exception escaping to strand the
    // rest of the document unrendered.
    figure.dataset[FIGURE_KEY] = 'error';
    figure.append(errorNote(error));
    pre.style.display = '';
  } finally {
    stage.remove();
  }

  pre.replaceWith(figure);
  figure.append(pre);
}

/**
 * Mermaid sanitizes its own output first, with a config loose enough to keep
 * <foreignObject>. This is the pass that decides what actually enters the page.
 */
function sanitizeSvg(svg: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(svg, {
    ...SVG_PURIFY_CONFIG,
    RETURN_DOM_FRAGMENT: true,
  });

  // DOMPurify does not look inside CSS, and mermaid's <style> block carries
  // whatever `classDef` and `style` directives the document asked for. Mermaid
  // scopes those rules to the diagram's own id and balances their braces, so
  // the risk left is not a selector escaping — it is `fill: url(https://…)`
  // quietly becoming this extension's only outbound request.
  for (const style of fragment.querySelectorAll('style')) {
    style.textContent = withoutRemoteRefs(style.textContent ?? '');
  }
  for (const element of fragment.querySelectorAll('[style]')) {
    element.setAttribute(
      'style',
      withoutRemoteRefs(element.getAttribute('style') ?? ''),
    );
  }

  // Reaching here with nothing left means the diagram was entirely made of
  // things we refuse. Better to say so than to hang an empty figure in the page.
  if (!fragment.querySelector('svg')) {
    throw new Error('the diagram did not survive sanitization');
  }

  return fragment;
}

function withoutRemoteRefs(css: string): string {
  return css.replace(REMOTE_CSS, '');
}

function errorNote(error: unknown): HTMLElement {
  const note = document.createElement('p');
  note.style.cssText =
    'margin:0 0 0.4em;font-size:0.9em;color:var(--mdv-tk-deletion,#b3202c);';
  // textContent, not markup: mermaid quotes the offending line back in its
  // message, so this string contains text from the document itself.
  note.textContent = `Diagram could not be rendered — ${describe(error)}`;
  return note;
}

/** Mermaid's parse errors are a line of prose followed by an ASCII caret map. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] || 'unknown error').trim().slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

function mermaidConfig(): MermaidConfig {
  return {
    // Rendering is driven from here; mermaid's own document scan would fight
    // the observer below over the same blocks.
    startOnLoad: false,
    // The floor, not the ceiling: strict disables click bindings and script
    // directives and escapes the labels mermaid itself writes. `sanitizeSvg`
    // is what decides whether the result may enter the page.
    securityLevel: 'strict',
    // Labels as SVG <text> instead of <foreignObject> wrapping XHTML. DOMPurify
    // refuses foreignObject on principle, so an HTML label would reach the page
    // as an empty box — not producing one is better than sanitizing it away.
    // The cost is markdown formatting inside labels, which is a fair trade.
    htmlLabels: false,
    // Otherwise mermaid plants its own error diagram in the staging element and
    // leaves it there. Failures are reported by `errorNote` instead.
    suppressErrorRendering: true,
    // Resolved against the figure — and against the staging element beside it —
    // so the font mermaid measures with is the font it is drawn in.
    fontFamily: 'inherit',
    theme: isDark() ? 'dark' : 'default',
  };
}

function isDark(): boolean {
  return document.documentElement.dataset[VIEWER_THEME_DATASET_KEY] === 'dark';
}

/** `mdvTheme` → `data-mdv-theme`. config.ts publishes the dataset spelling. */
function attributeName(datasetKey: string): string {
  return `data-${datasetKey.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

/* -------------------------------------------------------------------------- */
/* Staying current                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mermaid bakes its palette into each SVG at render time, so following the
 * theme means drawing again — which is why this changes mermaid's own theme
 * config rather than pushing CSS over the top of a diagram drawn for the other
 * one. Restoring each block before re-running keeps it a single code path.
 */
function watchTheme(root: HTMLElement): void {
  let dark = isDark();

  const observer = new MutationObserver(() => {
    if (isDark() === dark) return;
    dark = !dark;

    for (const figure of root.querySelectorAll<HTMLElement>(`[${FIGURE_ATTR}]`)) {
      const pre = figure.querySelector('pre');
      if (!pre) {
        figure.remove();
        continue;
      }
      pre.style.display = '';
      figure.replaceWith(pre);
    }

    void render(root);
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [attributeName(VIEWER_THEME_DATASET_KEY)],
  });
}

/**
 * The viewer rebuilds its body from the parsed HTML whenever the document
 * changes — the raw/rendered toggle on its own is enough — and every diagram
 * goes with it. Re-running the pass is both simpler and more reliable than
 * trying to survive the replacement, and it costs one failed query when there
 * is nothing to redraw.
 */
function watchDocument(root: HTMLElement): void {
  let scheduled = false;

  const observer = new MutationObserver(() => {
    // Our own replacements are mutations too. Ignoring them while a pass is in
    // flight is what keeps this from feeding itself.
    if (scheduled || rendering) return;

    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      void render(root);
    });
  });

  observer.observe(root, { childList: true, subtree: true });
}
