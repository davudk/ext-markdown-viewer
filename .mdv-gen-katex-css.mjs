/* One-shot generator for entrypoints/katex-theme.css + public/fonts/*.woff2. */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'node_modules/katex/dist';
const FONT_OUT = 'public/fonts';

mkdirSync(FONT_OUT, { recursive: true });
const woff2 = readdirSync(join(SRC, 'fonts')).filter((f) => f.endsWith('.woff2'));
for (const name of woff2) copyFileSync(join(SRC, 'fonts', name), join(FONT_OUT, name));

/** Generic families to fall back to, per KaTeX face, when a woff2 cannot load. */
const FALLBACK = [
  ['KaTeX_Typewriter', `"Courier New",Courier,monospace`],
  ['KaTeX_SansSerif', `Helvetica,Arial,sans-serif`],
  ['KaTeX_Script', `cursive,serif`],
  ['KaTeX_Caligraphic', `cursive,serif`],
  ['KaTeX_Fraktur', `"Times New Roman",Times,serif`],
  ['KaTeX_Math', `"Times New Roman",Times,serif`],
  ['KaTeX_AMS', `"Times New Roman",Times,serif`],
  ['KaTeX_Main', `"Times New Roman",Times,serif`],
  ['KaTeX_Size', `"Times New Roman",Times,serif`],
];

function fallbackFor(family) {
  const hit = FALLBACK.find(([prefix]) => family.startsWith(prefix));
  return hit ? hit[1] : `serif`;
}

const css = readFileSync(join(SRC, 'katex.min.css'), 'utf8');

// Split into @font-face blocks and everything else: the two need opposite
// treatment, and `font-family` inside a face declares the name rather than
// using it.
const parts = css.split(/(@font-face\{[^}]*\})/g).filter(Boolean);

let faces = 0;
const rewritten = parts
  .map((part) => {
    if (!part.startsWith('@font-face{')) {
      return part.replace(
        /font-family:(KaTeX_[A-Za-z0-9]+)/g,
        (_, family) => `font-family:${family},${fallbackFor(family)}`,
      );
    }

    faces += 1;
    return part
      // woff2 only. Every browser this extension runs in supports it, and the
      // .ttf/.woff twins would triple the packaged size for nothing.
      .replace(/src:[^;}]*/, (src) => {
        const file = /fonts\/([\w-]+)\.woff2/.exec(src)?.[1];
        if (!file) throw new Error(`no woff2 in: ${src}`);
        return `src:url(../fonts/${file}.woff2) format("woff2")`;
      })
      // `block` hides the glyphs for three seconds before conceding; `swap`
      // shows the fallback immediately. The files are local, so the swap is
      // never visible in the normal case and always visible in the broken one.
      .replace('font-display:block', 'font-display:swap');
  })
  .join('');

const HEADER = `/* Markdown Viewer — KaTeX stylesheet for the math add-on.

   Generated from node_modules/katex/dist/katex.min.css (katex 0.17.0), with
   three changes, none of which are hand-maintained edits to the rules below:

     1. Every @font-face src is reduced to its .woff2 and repointed at
        ../fonts/, i.e. at the extension's own root. The path is relative to
        this file's location in the build output (assets/katex-theme.css), so
        it resolves to chrome-extension://<id>/fonts/<name>.woff2 — the fonts
        are packaged, and the extension never asks the network for anything.
        They have to be listed in web_accessible_resources as \`fonts/*.woff2\`
        or the page is not permitted to load them.
     2. font-display: block -> swap, so a font that fails to load costs a
        change of typeface rather than three seconds of invisible formulae.
     3. A generic fallback family is appended to every font-family that names a
        KaTeX face, so the same failure lands on a serif instead of on whatever
        the browser picks for an unknown family.

   Regenerate rather than edit; see the header of entrypoints/katex-addon.ts.

   Everything after the KaTeX rules is ours. */

`;

const OURS = `

/* ==========================================================================
   Markdown Viewer additions
   ========================================================================== */

/* A display equation is one long unbreakable line; the measure is not. Let it
   scroll inside its own box rather than pushing the whole document sideways.
   \`overflow-y\` is pinned because a lone \`overflow-x: auto\` computes the other
   axis to \`auto\` too, which clips the parts of a formula that sit above and
   below the line box. */
.katex-display {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.5em 0;
}

/* Set by the add-on on the ones that actually overflow, so they can be reached
   and scrolled from the keyboard. */
.katex-display[tabindex]:focus-visible {
  outline: 2px solid var(--mdv-accent, #0a53be);
  outline-offset: 2px;
  border-radius: var(--mdv-radius-sm, 4px);
}

/* KaTeX writes \`color: #cc0000\` inline on a formula it could not parse, which
   is unreadable on the dark theme. Overriding an inline style is the one thing
   !important is for. */
.katex-error {
  color: var(--mdv-tk-deletion, #b3202c) !important;
  font-family: var(--mdv-font-mono, ui-monospace, monospace);
  font-size: 0.9em;
  white-space: pre-wrap;
}
`;

const out = HEADER + rewritten.trim() + OURS;
writeFileSync('entrypoints/katex-theme.css', out);

console.log(`fonts copied: ${woff2.length}`);
console.log(`@font-face blocks rewritten: ${faces}`);
console.log(`css bytes: ${out.length}`);
console.log(`remaining non-local url(): ${(out.match(/url\((?!\.\.\/fonts\/)[^)]*\)/g) ?? []).join(', ') || 'none'}`);
