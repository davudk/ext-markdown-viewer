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
 *
 * Around each finished drawing sits a viewer: pan and zoom, a fullscreen mode,
 * and SVG/PNG export. All of it is local — the exported SVG is made
 * self-contained *before* it is serialized, so a file that leaves this browser
 * does not quietly depend on the page it came from.
 */

import DOMPurify, { type Config as PurifyConfig } from 'dompurify';
import mermaid, { type MermaidConfig } from 'mermaid';
import createPanZoom, { type PanZoom } from 'panzoom';

import {
  MERMAID_LANGUAGE,
  VIEWER_ROOT_ID,
  VIEWER_THEME_DATASET_KEY,
} from '@/lib/config';

/* -------------------------------------------------------------------------- */
/* Pan, zoom and export                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Every value below is read here and nowhere else, so it lives here rather than
 * in `lib/config.ts`: a diagram's zoom range is a fact about this add-on's
 * viewport, not a shared identifier any other context needs.
 */

/**
 * Zoom limits and the multiplier one button press or `+`/`-` applies.
 *
 * `min` is below 1 because the reason to zoom a diagram out is that it is
 * already wider than the measure; `max` is the point past which the vectors
 * stop carrying more than the screen can show.
 */
const MERMAID_ZOOM = { min: 0.25, max: 12, step: 1.4 } as const;

/** Pixels a diagram moves per arrow-key press. */
const MERMAID_PAN_STEP_PX = 48;

/**
 * Retina. A diagram exported at 1× is a screenshot of a vector drawing and
 * looks like one the moment it is placed in anything.
 */
const MERMAID_PNG_SCALE = 2;

/** Ceiling on either PNG dimension, so a wall-sized diagram cannot exhaust memory. */
const MERMAID_PNG_MAX_PX = 8_192;

/** Size for a diagram whose SVG carries neither a viewBox nor an explicit one. */
const MERMAID_EXPORT_FALLBACK = { width: 960, height: 540 } as const;

/** Basename of an exported diagram, before its index and extension. */
const MERMAID_EXPORT_BASENAME = 'diagram';

/** The blocks `lib/markdown.ts` passes through unhighlighted for us. */
const BLOCK_SELECTOR = `pre > code.language-${MERMAID_LANGUAGE}`;

/** On the <figure> that takes a block's place: 'ok' or 'error'. */
const FIGURE_KEY = 'mdvMermaid';
const FIGURE_ATTR = attributeName(FIGURE_KEY);

/** On <html>, so the observers below are wired exactly once per document. */
const INSTALLED_KEY = 'mdvMermaidAddon';

/** Id of the stylesheet element this add-on plants in <head>. */
const STYLE_ID = 'mdv-mermaid-style';

/**
 * On the source `<pre>`: the pan/zoom transform, as JSON.
 *
 * The `<pre>` is the one node that survives a redraw — a theme change unwraps
 * every figure back to it and renders again — so parking the view there means
 * the diagram comes back where the reader left it rather than snapped to the
 * origin, with no registry to keep in step with the DOM.
 */
const VIEW_KEY = 'mdvMermaidView';

/** The <g> the transform is applied to, wrapped around mermaid's own output. */
const VIEWPORT_CLASS = 'mdv-mermaid-viewport';

/** The invisible drag target inside it; stripped before export. See `hitArea`. */
const HIT_CLASS = 'mdv-mermaid-hit';

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

/** The SVG namespace, for elements built by hand and for the export header. */
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Long enough for the browser to have read the blob. Mirrors `lib/export.ts`. */
const REVOKE_DELAY_MS = 60_000;

let counter = 0;
let rendering = false;

/** Live pan/zoom controllers, keyed by the figure each one drives. */
const controllers = new Map<HTMLElement, PanZoom>();

export default defineUnlistedScript(() => {
  const root = document.getElementById(VIEWER_ROOT_ID);
  // No viewer means nothing asked for this and there are no blocks of ours to
  // find. The renderer is the only legitimate caller.
  if (!root) return;

  installStyles();
  void render(root);

  const html = document.documentElement;
  if (html.dataset[INSTALLED_KEY]) return;
  html.dataset[INSTALLED_KEY] = 'on';

  watchTheme(root);
  watchDocument(root);
  watchFullscreen();
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

async function render(root: HTMLElement): Promise<void> {
  if (rendering) return;

  // A figure that has left the document takes its controller's listeners and
  // animation frame with it unless they are disposed.
  for (const [figure, controller] of controllers) {
    if (!figure.isConnected) {
      controller.dispose();
      controllers.delete(figure);
    }
  }

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

  // Mermaid sizes a diagram by measuring its labels, and getBBox reports zeroes
  // for anything the browser has not laid out — which rules out `display:none`
  // and `visibility:hidden` both. Staging it beside the block it replaces gets
  // it laid out *and* inheriting the same typography, so what mermaid measures
  // is what the reader ends up looking at.
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText = 'position:absolute;left:-99999px;top:0;width:1200px;';
  pre.before(stage);

  let drawing: SVGSVGElement | null = null;

  try {
    const { svg } = await mermaid.render(
      `mdv-mermaid-${(counter += 1)}`,
      code.textContent ?? '',
      stage,
    );

    drawing = sanitizeSvg(svg);
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

  if (drawing) figure.append(viewer(drawing));

  pre.replaceWith(figure);
  figure.append(pre);

  // After insertion, never before: pan/zoom measures the element, and an
  // unattached SVG measures as nothing.
  if (drawing) activate(figure, pre);
}

/**
 * Mermaid sanitizes its own output first, with a config loose enough to keep
 * <foreignObject>. This is the pass that decides what actually enters the page.
 */
function sanitizeSvg(svg: string): SVGSVGElement {
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
  const drawing = fragment.querySelector('svg');
  if (!drawing) throw new Error('the diagram did not survive sanitization');

  return drawing;
}

function withoutRemoteRefs(css: string): string {
  return css.replace(REMOTE_CSS, '');
}

function errorNote(error: unknown): HTMLElement {
  const note = document.createElement('p');
  note.className = 'mdv-mermaid-error';
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
/* The viewer around a diagram                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a finished drawing in the box it will be panned inside, and the
 * controls that drive it.
 *
 * The stage is a region with a tab stop rather than a decorative div: a picture
 * that can only be moved by dragging is a picture half the readers cannot move
 * at all. Its key handling lives in `activate`.
 */
function viewer(drawing: SVGSVGElement): HTMLElement {
  const stage = document.createElement('div');
  stage.className = 'mdv-mermaid-stage';
  stage.tabIndex = 0;
  stage.setAttribute('role', 'region');
  stage.setAttribute(
    'aria-label',
    'Diagram. Arrow keys pan, plus and minus zoom, 0 resets.',
  );

  // Mermaid caps the drawing at its measured width with an inline style, which
  // no stylesheet can outrank and which stops the stage from filling. The
  // `width`/`height` *attributes* deliberately stay: CSS overrides them here,
  // and they are the intrinsic size everything outside this add-on falls back
  // to — presentation mode among them.
  drawing.style.removeProperty('max-width');

  // The stage's shape, from the drawing's own proportions. The stylesheet
  // turns this into a height and clamps it at both ends — see
  // `.mdv-mermaid-stage`. Without it the box is whatever `height: auto` makes
  // of the aspect ratio at the column's width, which for the wide, short
  // diagrams mermaid most often produces is a letterbox slot a few lines tall.
  const box = viewBoxOf(drawing);
  stage.style.setProperty('--mdv-mermaid-aspect', `${box.width} / ${box.height}`);

  drawing.append(viewport(drawing));
  stage.append(drawing);

  const controls = document.createElement('div');
  controls.className = 'mdv-mermaid-controls';
  // Screen-only UI, stripped by the print rule in viewer.css that matches on
  // this attribute rather than on any class name.
  controls.setAttribute('data-mdv-chrome', '');

  // One box holding both, so the controls can be positioned against the stage
  // rather than against a <figure> that also contains the hidden source.
  const frame = document.createElement('div');
  frame.className = 'mdv-mermaid-frame';
  frame.append(stage, controls);
  return frame;
}

/**
 * Moves the drawing's contents into a `<g>` the transform can be written to,
 * leaving `<style>` and `<defs>` where they are — the first because a rule set
 * has no position, the second because references resolve by id wherever it sits.
 */
function viewport(drawing: SVGSVGElement): SVGGElement {
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', VIEWPORT_CLASS);

  for (const child of [...drawing.children]) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'style' || tag === 'defs') continue;
    group.append(child);
  }

  // Behind the drawing, not over it: on top it would swallow every pointer
  // event the diagram's own shapes should get, text selection included.
  group.prepend(hitArea(drawing));
  return group;
}

/**
 * An invisible rectangle behind the drawing, so a drag that starts on empty
 * space still pans.
 *
 * Pan/zoom listens on the `<g>`, and an SVG group only receives a pointer event
 * where one of its children is painted — which for most diagrams is a minority
 * of the box. The rectangle is drawn several times the size of the viewBox
 * because it scales with the content: at the minimum zoom it still has to cover
 * the whole stage.
 */
function hitArea(drawing: SVGSVGElement): SVGRectElement {
  const box = viewBoxOf(drawing);
  const spread = 4;

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', HIT_CLASS);
  rect.setAttribute('x', String(box.x - box.width * spread));
  rect.setAttribute('y', String(box.y - box.height * spread));
  rect.setAttribute('width', String(box.width * (spread * 2 + 1)));
  rect.setAttribute('height', String(box.height * (spread * 2 + 1)));
  rect.setAttribute('fill', 'none');
  // `all` is what makes an unfilled shape a hit target at all.
  rect.style.pointerEvents = 'all';
  return rect;
}

/** Breathing room around an exported diagram, in the drawing's own units. */
const MERMAID_EXPORT_PADDING = 8;

/**
 * The box the drawing actually occupies, rather than the one it declares.
 *
 * Mermaid's `viewBox` is generous — it reserves room for the largest label it
 * measured, and for several diagram types it is a good deal taller and wider
 * than anything it drew. Exporting against it is where the margin of white
 * around a downloaded PNG comes from, and cropping to the real geometry is a
 * better answer than trimming pixels afterwards, because it fixes the SVG
 * export at the same time.
 *
 * Measured as the union of the viewport group's children, skipping the hit
 * rectangle — which is nine times the size of the diagram on purpose and would
 * otherwise *be* the answer. `getBBox` reports local user-space coordinates,
 * untouched by the pan/zoom transform on the group, so what comes out does not
 * depend on where the reader happened to leave the view.
 *
 * Falls back to the declared `viewBox` whenever the measurement is unavailable
 * or degenerate: a detached or `display:none` element measures as zero, and an
 * export that silently produced a 0×0 canvas would be worse than a roomy one.
 */
function contentBoxOf(drawing: SVGSVGElement) {
  const group = drawing.querySelector<SVGGElement>(`.${VIEWPORT_CLASS}`);
  if (!group) return viewBoxOf(drawing);

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const child of group.children) {
    if (child.classList.contains(HIT_CLASS)) continue;

    let box: DOMRect;
    try {
      box = (child as SVGGraphicsElement).getBBox();
    } catch {
      // Non-rendered children (`<title>`, a stray text node wrapper) throw
      // rather than measuring; they are also not part of the picture.
      continue;
    }

    if (box.width <= 0 && box.height <= 0) continue;
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }

  const width = right - left;
  const height = bottom - top;
  if (!(width > 0 && height > 0)) return viewBoxOf(drawing);

  const pad = MERMAID_EXPORT_PADDING;
  return {
    x: left - pad,
    y: top - pad,
    width: width + pad * 2,
    height: height + pad * 2,
  };
}

function viewBoxOf(drawing: SVGSVGElement) {
  const parts = (drawing.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map(Number);

  if (parts.length === 4 && parts.every((value) => Number.isFinite(value))) {
    const [x, y, width, height] = parts;
    if (width > 0 && height > 0) return { x, y, width, height };
  }

  return { x: 0, y: 0, ...MERMAID_EXPORT_FALLBACK };
}

/* -------------------------------------------------------------------------- */
/* Driving it                                                                  */
/* -------------------------------------------------------------------------- */

function activate(figure: HTMLElement, source: HTMLElement): void {
  const drawing = figure.querySelector('svg');
  const group = figure.querySelector<SVGGElement>(`.${VIEWPORT_CLASS}`);
  const stage = figure.querySelector<HTMLElement>('.mdv-mermaid-stage');
  const controls = figure.querySelector<HTMLElement>('.mdv-mermaid-controls');
  if (!drawing || !group || !stage || !controls) return;

  const pz = createPanZoom(group, {
    minZoom: MERMAID_ZOOM.min,
    maxZoom: MERMAID_ZOOM.max,
    // The single most common complaint about diagram viewers: a page that stops
    // scrolling because the pointer happened to cross a picture. Returning true
    // hands the event back to the browser untouched. Ctrl also covers a trackpad
    // pinch, which arrives as a wheel event with ctrlKey set.
    beforeWheel: (event: WheelEvent) => !(event.ctrlKey || event.metaKey),
    // The owner is a <g>, which cannot hold focus; the stage handles keys itself
    // so that they arrive at the diagram the reader has actually tabbed to.
    disableKeyboardInteraction: true,
    // Double-click belongs to text selection and to the browser, not to us.
    zoomDoubleClickSpeed: 1,
    // Momentum after a drag reads as the diagram drifting on its own.
    smoothScroll: false,
  });

  controllers.set(figure, pz);
  restoreView(pz, source);
  pz.on('transform', () => rememberView(pz, source));

  addButton(controls, 'Zoom in', ICON_ZOOM_IN, () => scale(pz, stage, drawing, MERMAID_ZOOM.step));
  addButton(controls, 'Zoom out', ICON_ZOOM_OUT, () => scale(pz, stage, drawing, 1 / MERMAID_ZOOM.step));
  addButton(controls, 'Reset view', ICON_RESET, () => reset(pz));
  addButton(controls, 'Fullscreen', ICON_FULLSCREEN, () => void toggleFullscreen(figure));
  addButton(controls, 'Download SVG', ICON_SVG, () => exportSvg(figure));
  addButton(controls, 'Download PNG', ICON_PNG, () => void exportPng(figure));

  stage.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;

    const step = MERMAID_PAN_STEP_PX;
    switch (event.key) {
      case 'ArrowUp':
        pz.moveBy(0, step, false);
        break;
      case 'ArrowDown':
        pz.moveBy(0, -step, false);
        break;
      case 'ArrowLeft':
        pz.moveBy(step, 0, false);
        break;
      case 'ArrowRight':
        pz.moveBy(-step, 0, false);
        break;
      case '+':
      case '=':
        scale(pz, stage, drawing, MERMAID_ZOOM.step);
        break;
      case '-':
      case '_':
        scale(pz, stage, drawing, 1 / MERMAID_ZOOM.step);
        break;
      case '0':
        reset(pz);
        break;
      default:
        return;
    }

    event.preventDefault();
  });
}

/**
 * Zoom about the middle of the stage.
 *
 * `zoomTo` wants coordinates relative to pan/zoom's **owner**, which for the
 * SVG controller is `ownerSVGElement` — the `<svg>` — not the `<g>` the
 * transform is written to. Measuring against the `<g>` is the bug this replaces,
 * and it is the kind that looks almost right: the `<g>`'s rectangle *is* the
 * drawing, so at the default view the two nearly coincide. The moment the
 * reader pans or zooms, the `<g>` moves and the anchor moves with it, so every
 * subsequent zoom pulls toward wherever the drawing has drifted rather than
 * holding the middle of the frame still. Panzoom's own wheel handler measures
 * against the owner (`getOffsetXY`), which is why wheel zoom always felt right
 * and the buttons did not.
 */
function scale(
  pz: PanZoom,
  stage: HTMLElement,
  drawing: SVGSVGElement,
  factor: number,
): void {
  const box = stage.getBoundingClientRect();
  const owner = drawing.getBoundingClientRect();

  pz.zoomTo(
    box.left + box.width / 2 - owner.left,
    box.top + box.height / 2 - owner.top,
    factor,
  );
}

function reset(pz: PanZoom): void {
  pz.zoomAbs(0, 0, 1);
  pz.moveTo(0, 0);
}

function rememberView(pz: PanZoom, source: HTMLElement): void {
  const { x, y, scale: zoom } = pz.getTransform();
  source.dataset[VIEW_KEY] = JSON.stringify({ x, y, scale: zoom });
}

function restoreView(pz: PanZoom, source: HTMLElement): void {
  const stored = source.dataset[VIEW_KEY];
  if (!stored) return;

  try {
    const { x, y, scale: zoom } = JSON.parse(stored) as Record<string, number>;
    if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) return;
    pz.zoomAbs(0, 0, zoom);
    pz.moveTo(x, y);
  } catch {
    // A hand-edited attribute is not worth a broken diagram.
    delete source.dataset[VIEW_KEY];
  }
}

function addButton(
  controls: HTMLElement,
  label: string,
  icon: string,
  onClick: () => void,
): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mdv-mermaid-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  // Built from a constant, never from anything in the document.
  button.innerHTML = icon;
  button.addEventListener('click', onClick);
  controls.append(button);
}

/* -------------------------------------------------------------------------- */
/* Fullscreen                                                                  */
/* -------------------------------------------------------------------------- */

/** Whatever had focus when fullscreen was entered, so it can be given back. */
let returnFocus: HTMLElement | null = null;

async function toggleFullscreen(figure: HTMLElement): Promise<void> {
  if (document.fullscreenElement === figure) {
    await document.exitFullscreen().catch(() => undefined);
    return;
  }

  returnFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  try {
    await figure.requestFullscreen();
  } catch {
    // Refused — an iframe without `allowfullscreen`, or a browser that declines
    // the gesture. A fixed overlay is the same view without the top layer.
    figure.dataset.mdvMermaidCover = 'on';
    figure.querySelector<HTMLElement>('.mdv-mermaid-stage')?.focus();
  }
}

/**
 * Focus is trapped for as long as a diagram is full screen, and handed back on
 * the way out.
 *
 * Native fullscreen hides the rest of the page but does not take it out of the
 * tab order, so without this Tab walks off the diagram and into a document
 * nobody can see. `fullscreenchange` also covers the exits we never asked for —
 * Escape, and the browser's own control.
 */
function watchFullscreen(): void {
  const onFocusIn = (event: FocusEvent) => {
    const figure = document.fullscreenElement;
    if (!figure || figure.contains(event.target as Node)) return;
    figure.querySelector<HTMLElement>('.mdv-mermaid-stage')?.focus();
  };

  document.addEventListener('fullscreenchange', () => {
    const figure = document.fullscreenElement;

    if (figure) {
      document.addEventListener('focusin', onFocusIn);
      figure.querySelector<HTMLElement>('.mdv-mermaid-stage')?.focus();
      return;
    }

    document.removeEventListener('focusin', onFocusIn);
    // Before the focus call, or the trap above pulls it straight back.
    returnFocus?.focus({ preventScroll: true });
    returnFocus = null;
  });

  // The fallback cover has no browser-level exit, so it needs its own.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const cover = document.querySelector<HTMLElement>('[data-mdv-mermaid-cover]');
    if (!cover) return;

    delete cover.dataset.mdvMermaidCover;
    returnFocus?.focus({ preventScroll: true });
    returnFocus = null;
  });
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A copy of the drawing that does not depend on this page.
 *
 * This is the whole difficulty with exporting an SVG out of a page. The one on
 * screen is only half a picture: `fontFamily: 'inherit'` in `mermaidConfig`
 * means its type is resolved against the document, `currentColor` resolves
 * against whatever encloses it, and the size comes from a stylesheet that is
 * not travelling with the file. Serializing it as it stands produces something
 * that renders correctly in exactly one place.
 *
 * So the clone is given, explicitly: both namespaces, a real width and height,
 * the typography and colour the browser had actually resolved, and a background
 * — a dark-theme diagram on a viewer's white page is otherwise invisible. What
 * it loses is the reader's current pan and zoom, deliberately: the export is
 * the diagram, not the part of it that happened to be on screen.
 */
function selfContained(figure: HTMLElement): SVGSVGElement | null {
  const live = figure.querySelector('svg');
  if (!live) return null;

  const clone = live.cloneNode(true) as SVGSVGElement;
  const box = contentBoxOf(live);

  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', XLINK_NS);
  clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  clone.setAttribute('width', String(box.width));
  clone.setAttribute('height', String(box.height));

  clone.querySelector(`.${VIEWPORT_CLASS}`)?.removeAttribute('transform');
  clone.querySelector(`.${HIT_CLASS}`)?.remove();

  // Everything the page was supplying, written down. Resolved from the live
  // element, so what lands in the file is what was on screen.
  const computed = getComputedStyle(live);
  clone.style.cssText = '';
  clone.style.setProperty('font-family', computed.fontFamily);
  clone.style.setProperty('font-size', computed.fontSize);
  clone.style.setProperty('color', computed.color);
  clone.style.setProperty('background-color', pageBackground());

  // The sanitizer already did this to what entered the page; the clone is
  // re-checked because it is about to leave, and a file that phones home the
  // moment it is opened somewhere else is worse than one that never worked.
  for (const style of clone.querySelectorAll('style')) {
    style.textContent = withoutRemoteRefs(style.textContent ?? '');
  }
  for (const element of clone.querySelectorAll<SVGElement>('[style]')) {
    element.setAttribute(
      'style',
      withoutRemoteRefs(element.getAttribute('style') ?? ''),
    );
  }
  for (const element of clone.querySelectorAll('image, [href], [*|href]')) {
    const target =
      element.getAttribute('href') ?? element.getAttributeNS(XLINK_NS, 'href');
    if (target?.startsWith('#')) continue;
    element.removeAttribute('href');
    element.removeAttributeNS(XLINK_NS, 'href');
    if (element.tagName.toLowerCase() === 'image') element.remove();
  }

  return clone;
}

function pageBackground(): string {
  const body = getComputedStyle(document.body).backgroundColor;
  // `transparent` and `rgba(…, 0)` both mean "whatever is behind me", which in
  // a file is nothing at all.
  return /^(transparent|rgba\(.*,\s*0\)|)$/.test(body) ? '#ffffff' : body;
}

function serialize(drawing: SVGSVGElement): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(drawing)}`;
}

function exportSvg(figure: HTMLElement): void {
  const drawing = selfContained(figure);
  if (!drawing) return;

  saveBlob(
    new Blob([serialize(drawing)], { type: 'image/svg+xml;charset=utf-8' }),
    filename(figure, 'svg'),
  );
}

/**
 * The same drawing, rasterized locally.
 *
 * A data URL rather than an object URL because the image is about to be drawn
 * into a canvas that is then read back: a canvas is tainted by an image with
 * any external dependency, and the point of `selfContained` is that there is
 * none — the data URL makes that guarantee visible rather than assumed.
 */
async function exportPng(figure: HTMLElement): Promise<void> {
  const drawing = selfContained(figure);
  if (!drawing) return;

  const box = viewBoxOf(drawing);
  // 2× unless that would blow past the pixel ceiling, in which case whatever
  // fits — a diagram too big to double is still worth exporting at 1× or less.
  const ratio = Math.max(
    0.1,
    Math.min(MERMAID_PNG_SCALE, MERMAID_PNG_MAX_PX / Math.max(box.width, box.height)),
  );

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);

  const context = canvas.getContext('2d');
  if (!context) return;

  try {
    const image = await load(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialize(drawing))}`,
    );

    // PNG supports transparency and a viewer's dark chrome would then swallow
    // black text. The diagram gets the background it was drawn against.
    context.fillStyle = pageBackground();
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (blob) saveBlob(blob, filename(figure, 'png'));
  } catch {
    // Nothing useful to say and nothing broken: the diagram is still on screen
    // and the SVG export does not go through a canvas at all.
  }
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => reject(new Error('the diagram could not be rasterized')));
    image.src = src;
  });
}

/** `diagram-2.png`, numbered by position among the diagrams in the document. */
function filename(figure: HTMLElement, extension: string): string {
  const figures = [...document.querySelectorAll(`[${FIGURE_ATTR}]`)];
  const index = figures.indexOf(figure) + 1;
  return `${MERMAID_EXPORT_BASENAME}-${index || 1}.${extension}`;
}

/**
 * `chrome.downloads` is an extension-page API and this is a content script, so
 * the object-URL path `lib/export.ts` keeps as a fallback is the only path here
 * — same shape, same deferred revoke, and for the same reason: the browser has
 * not necessarily opened the blob by the time the click returns.
 */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';

  document.body.append(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
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
    // so the font mermaid measures with is the font it is drawn in. `export`
    // writes the resolved value into the file, since `inherit` means nothing
    // once the drawing has left this page.
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

/**
 * The add-on ships no stylesheet file — it is injected as a script alone, and
 * adding one would mean a second build artifact and a second `ADDONS` entry for
 * about forty rules. They are planted once per document instead, and every
 * colour is a `--mdv-*` token so both themes are covered with no media query.
 */
function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLESHEET;
  document.head.append(style);
}

const STYLESHEET = `
.mdv-mermaid {
  position: relative;
  margin: 0 0 1.15em;
  max-width: 100%;
}

.mdv-mermaid-frame {
  position: relative;
  border: 1px solid var(--mdv-border);
  border-radius: var(--mdv-radius);
  overflow: hidden;
}

/* The stage is sized by the diagram's own proportions, then clamped at both
   ends. 'height: auto' alone gives the box whatever the aspect ratio makes of
   the column width, which is a slot a few lines tall for the wide, short
   diagrams mermaid produces most often — and a full screen of scrolling for a
   tall flowchart.

   'min-height' is the floor that stops the letterbox; 'max-height' keeps a
   diagram from taking over the page, and is a share of the viewport rather
   than a fixed length so it means the same thing on a laptop and a monitor.
   'aspect-ratio' is only consulted while height is 'auto', which is what lets
   the fullscreen rules below take over by setting one. */
.mdv-mermaid-stage {
  aspect-ratio: var(--mdv-mermaid-aspect, 16 / 9);
  min-height: 13rem;
  max-height: 70vh;
  overflow: hidden;
  /* Or the browser claims every drag as a scroll before pan/zoom sees it. */
  touch-action: none;
  cursor: grab;
}

.mdv-mermaid-stage:active { cursor: grabbing; }

/* Fills the stage and fits inside it. An SVG with a viewBox defaults to
   'preserveAspectRatio: xMidYMid meet', so a box the clamps made shorter or
   taller than the drawing letterboxes it centred rather than cropping it —
   which also means the reader's starting view is the whole diagram, whatever
   the clamps did. */
.mdv-mermaid-stage > svg {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
}

.mdv-mermaid-controls {
  position: absolute;
  top: 0.4rem;
  right: 0.4rem;
  display: flex;
  gap: 0.2rem;
  padding: 0.15rem;
  background-color: color-mix(in srgb, var(--mdv-surface) 88%, transparent);
  border: 1px solid var(--mdv-border);
  border-radius: var(--mdv-radius-sm);
  /* Opacity, never display or visibility: both would take the buttons out of
     the tab order, and a control you can only reach with a mouse is not one. */
  opacity: 0;
  transition: opacity var(--mdv-dur) ease;
}

.mdv-mermaid:hover .mdv-mermaid-controls,
.mdv-mermaid:focus-within .mdv-mermaid-controls { opacity: 1; }

.mdv-mermaid-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  color: var(--mdv-fg);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--mdv-radius-sm);
}

.mdv-mermaid-button:hover { background-color: var(--mdv-surface-alt); }

.mdv-mermaid-error {
  margin: 0 0 0.4em;
  font-size: 0.9em;
  color: var(--mdv-tk-deletion);
}

.mdv-mermaid:fullscreen,
.mdv-mermaid[data-mdv-mermaid-cover] {
  background-color: var(--mdv-bg);
}

.mdv-mermaid[data-mdv-mermaid-cover] {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  margin: 0;
}

.mdv-mermaid:fullscreen .mdv-mermaid-frame,
.mdv-mermaid[data-mdv-mermaid-cover] .mdv-mermaid-frame {
  height: 100%;
  border: 0;
  border-radius: 0;
}

/* An explicit height, which suppresses 'aspect-ratio'; 'max-height' has to go
   with it or a fullscreen diagram would still be capped at 70% of the screen
   it was just given all of. */
.mdv-mermaid:fullscreen .mdv-mermaid-stage,
.mdv-mermaid[data-mdv-mermaid-cover] .mdv-mermaid-stage {
  height: 100%;
  min-height: 0;
  max-height: none;
}

.mdv-mermaid:fullscreen .mdv-mermaid-stage > svg,
.mdv-mermaid[data-mdv-mermaid-cover] .mdv-mermaid-stage > svg {
  height: 100%;
}

/* The source travels with the diagram for the copy button and the export, and
   fullscreen must not put it back on screen underneath the drawing. */
.mdv-mermaid:fullscreen > pre,
.mdv-mermaid[data-mdv-mermaid-cover] > pre { display: none !important; }

.mdv-mermaid-stage:focus-visible {
  outline: 2px solid var(--mdv-accent);
  outline-offset: -2px;
}

@media (prefers-reduced-motion: reduce) {
  .mdv-mermaid-controls { transition: none; }
}
`;

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

const ICON = [
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"',
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"',
  'stroke-linejoin="round" aria-hidden="true" focusable="false">',
].join(' ');

const ICON_ZOOM_IN = `${ICON}<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14M7 5.2v3.6M5.2 7h3.6"/></svg>`;
const ICON_ZOOM_OUT = `${ICON}<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3 14 14M5.2 7h3.6"/></svg>`;
const ICON_RESET = `${ICON}<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2.4v2.9h-2.9"/></svg>`;
const ICON_FULLSCREEN = `${ICON}<path d="M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10"/></svg>`;
const ICON_SVG = `${ICON}<path d="M8 2.4v7.4M5.2 7l2.8 2.8L10.8 7M2.8 12.2v1.4h10.4v-1.4"/></svg>`;
const ICON_PNG = `${ICON}<rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.4"/><circle cx="5.8" cy="6.4" r="1"/><path d="m2.8 11 3.4-3.1 3 2.6 2-1.7 2.2 2"/></svg>`;

/* -------------------------------------------------------------------------- */
/* Staying current                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mermaid bakes its palette into each SVG at render time, so following the
 * theme means drawing again — which is why this changes mermaid's own theme
 * config rather than pushing CSS over the top of a diagram drawn for the other
 * one. Restoring each block before re-running keeps it a single code path.
 *
 * Redrawing throws the old figure away, and with it the pan/zoom controller and
 * the controls attached to it. Both are rebuilt by the pass that follows; what
 * would otherwise be lost is the reader's place in the diagram, which is why
 * the transform lives on the surviving `<pre>` rather than in the controller.
 */
function watchTheme(root: HTMLElement): void {
  let dark = isDark();

  const observer = new MutationObserver(() => {
    if (isDark() === dark) return;
    dark = !dark;

    // A diagram cannot come back full screen without a fresh user gesture, and
    // leaving the browser in fullscreen over a figure that no longer exists is
    // worse than dropping out of it.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);

    for (const figure of root.querySelectorAll<HTMLElement>(`[${FIGURE_ATTR}]`)) {
      controllers.get(figure)?.dispose();
      controllers.delete(figure);

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
