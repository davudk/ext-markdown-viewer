/**
 * Cutting a rendered document into slides.
 *
 * This works on the rendered HTML rather than on the markdown source or on the
 * heading list, for one reason each: the source would mean a second parse and a
 * second set of rules about what `---` means (setext underline, front-matter
 * fence, table row); the heading list carries no content, only labels, so it
 * could say where the cuts go but not what falls between them. The rendered
 * body is the one representation that already agrees with what is on screen.
 *
 * Parsing happens into a `<template>`, whose content belongs to an inert
 * document: no image starts loading, no stylesheet is consulted, nothing is
 * requested. The HTML arriving here has already been through DOMPurify.
 */

/**
 * Where one slide is cut from the next.
 *
 * `auto` prefers `rule` and falls back to `heading`: almost no README carries a
 * single `---`, and presenting one as a wall of text is a worse answer than
 * cutting at its section headings, while a document that *does* carry rules was
 * written with the breaks exactly where the author wanted them.
 *
 * Declared here rather than in `lib/config.ts` because it is the argument
 * `splitSlides` takes; the presentation plugin's settings schema offers the same
 * three values, and `SettingsOf` makes a drift between the two a compile error
 * at the call site.
 */
export type SlideSplit = 'auto' | 'rule' | 'heading';

export interface Slide {
  /** The slide's markup, ready to be injected into a `.mdv-body` container. */
  html: string;
  /** Its first heading, if it opens with one. Used to label the slide, not to render it. */
  title: string;
}

/** An empty document is a deck of one blank slide, never a deck of none. */
const EMPTY_DECK: Slide[] = [{ html: '', title: '' }];

/** `nodeType === 1`, spelled out. `Node` is not a global in the bare test runner. */
const ELEMENT_NODE = 1;

function headingLevel(node: Node): number {
  if (node.nodeType !== ELEMENT_NODE) return 0;
  const match = /^H([1-6])$/.exec((node as Element).tagName);
  return match ? Number(match[1]) : 0;
}

function isRule(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && (node as Element).tagName === 'HR';
}

/** Whether a run of nodes amounts to anything worth putting on screen. */
function hasContent(nodes: Node[]): boolean {
  return nodes.some(
    (node) => node.nodeType === ELEMENT_NODE || (node.textContent ?? '').trim() !== '',
  );
}

/**
 * The heading level slides are cut at.
 *
 * Not simply "the shallowest": a README opens with one `#` title and then runs
 * on `##` sections, and cutting only at the `#` yields a title slide followed
 * by the entire rest of the document. The level that *repeats* is the one the
 * author used for sections, so that is the cut — falling back to the shallowest
 * when nothing repeats, which is the single-title case and correctly gives one
 * slide.
 *
 * Returns 0 when there are no headings at all, meaning "do not cut".
 */
function cutLevel(nodes: Node[]): number {
  const counts = new Map<number, number>();

  for (const node of nodes) {
    const level = headingLevel(node);
    if (level) counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  if (counts.size === 0) return 0;

  const levels = [...counts.keys()].sort((a, b) => a - b);
  return levels.find((level) => (counts.get(level) ?? 0) > 1) ?? levels[0];
}

/** The mode actually used, once `auto` has looked at the document. */
function resolveMode(mode: SlideSplit, nodes: Node[]): 'rule' | 'heading' {
  if (mode !== 'auto') return mode;
  // One rule is already two slides, and a document carrying even one was broken
  // into parts deliberately.
  return nodes.some(isRule) ? 'rule' : 'heading';
}

/**
 * Splits rendered document HTML into slides.
 *
 * Only top-level nodes are considered, so a `---` inside a blockquote or a
 * heading inside a list item is content rather than a page break — matching
 * every other markdown presenter, and keeping a nested structure from being
 * torn in half.
 */
export function splitSlides(html: string, mode: SlideSplit = 'auto'): Slide[] {
  const template = document.createElement('template');
  template.innerHTML = html;

  const nodes = [...template.content.childNodes];
  if (nodes.length === 0) return EMPTY_DECK;

  const resolved = resolveMode(mode, nodes);
  const level = resolved === 'heading' ? cutLevel(nodes) : 0;

  const groups: Node[][] = [];
  let current: Node[] = [];

  for (const node of nodes) {
    if (resolved === 'rule') {
      // The separator is the break, not content on either side of it.
      if (isRule(node)) {
        groups.push(current);
        current = [];
        continue;
      }
    } else if (level > 0 && headingLevel(node) > 0 && headingLevel(node) <= level) {
      // The heading opens the slide it introduces rather than closing the one
      // before it, so a title is never stranded at the bottom of a slide.
      groups.push(current);
      current = [node];
      continue;
    }

    current.push(node);
  }
  groups.push(current);

  const slides = groups.filter(hasContent).map(toSlide);
  return slides.length > 0 ? slides : EMPTY_DECK;
}

/**
 * Serializes one group. The nodes are moved rather than cloned — the template
 * they came from is discarded on return, and cloning a large document twice is
 * the one avoidable cost in this whole pass.
 */
function toSlide(nodes: Node[]): Slide {
  const holder = document.createElement('div');
  holder.append(...nodes);

  const heading = holder.querySelector('h1, h2, h3, h4, h5, h6');
  const title = heading?.textContent?.trim() ?? '';

  // Ids are dropped, and this is not tidying. A deck is shown *beside* the
  // document it came from, both live in the same page, and a duplicated id
  // breaks two things that matter: `getElementById` starts resolving to
  // whichever copy comes first in the DOM, and the scroll-memory pass — which
  // measures every `h1[id]`…`h6[id]` in the page — starts averaging the real
  // document's headings with a set of fixed-position ones whose offsets mean
  // nothing. The links those ids served scroll to a place a slide does not
  // have anyway.
  holder.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));

  return { html: holder.innerHTML, title };
}
