/**
 * Enforces the design system's token discipline against the source tree.
 * Run as part of `npm run verify`. Exits non-zero on any failure.
 *
 * The premise (docs/design-system.md, D10/D16): plugin stylesheets deliberately
 * duplicate *rules*, but every *value* of a governed kind must be a token. A
 * ladder only stays a ladder if a raw rung fails the build — the same bet
 * check-build.mjs and audit-network.mjs already make for their invariants.
 *
 * v1 governs the two kinds where a stray literal is unambiguous:
 *
 *   - z-index: a bare number is a stacking decision made outside the ladder.
 *     Allowed: var(--mdv-z-*), calc() over one, 0, -1, auto.
 *   - transition durations: a literal `ms` in a transition is a timing
 *     decision outside the motion scale. Animations are exempt — their
 *     durations (a spinner's period, a shimmer's sweep) are choreography, not
 *     state transitions, and the scale does not claim them.
 *
 * Also refuses the two retired single-use inset variables, which the corner
 * token replaced; their reappearance would mean the 12.12 decision regressed.
 *
 * Deliberately NOT governed (yet): spacing/type/opacity literals — the em
 * domain and non-semantic opacities make a grep too blunt to be a build
 * gate there; those stay review concerns until a smarter check exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Stylesheets the viewer delivers, plus the CSS embedded in the add-ons. */
const GOVERNED = [
  'components',
  'plugins',
  'lib/plugins',
  'entrypoints/viewer.css',
  'entrypoints/mermaid-addon.ts',
];

/** The token definitions themselves, and generated files, are exempt. */
const EXEMPT = new Set(['design/tokens.css', 'entrypoints/katex-theme.css']);

const RETIRED_VARS = ['--mdv-broken-count-inset', '--mdv-present-launch-inset'];

function walk(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

const failures = [];

const files = GOVERNED.flatMap((root) => walk(root)).filter(
  (file) => (file.endsWith('.css') || file.endsWith('.ts')) && !EXEMPT.has(file),
);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  // In .ts files only CSS template strings matter, but the patterns below are
  // specific enough (a `z-index:` or `transition:` declaration) that scanning
  // the whole file adds no false positives worth a parser.
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    const at = `${file}:${index + 1}`;

    const z = line.match(/z-index:\s*([^;]+);/);
    if (z) {
      const value = z[1].trim();
      const allowed =
        value === '0' || value === '-1' || value === 'auto' ||
        /^(calc\()?\s*var\(--mdv-z-/.test(value);
      if (!allowed) failures.push(`${at}: z-index outside the ladder — "${value}"`);
    }

    if (/transition[^;:]*:\s*[^;]*\b\d+(\.\d+)?ms/.test(line) && !/0\.01ms/.test(line)) {
      failures.push(`${at}: literal duration in a transition — use --mdv-dur*`);
    }

    for (const retired of RETIRED_VARS) {
      if (line.includes(retired)) {
        failures.push(`${at}: retired variable ${retired} — use --mdv-inset-corner`);
      }
    }
  });
}

/* --------------------------------------------------------------------------
 * Colour agreement (decisions D4 and D14).
 *
 * The palette exists in three places that must agree by construction and have
 * only ever agreed by diligence: the `default` preset in lib/theme-presets.ts
 * (the typed source — it is what the contrast tests validate), the baseline
 * blocks in entrypoints/viewer.css, and the hand-mirrored EXPORT_CSS in
 * lib/export.ts. Plus the print palette, which lives in the two stylesheets
 * only. This is the "soft-first" half of D4: assert agreement now; generate
 * from the source only if this check ever becomes busywork.
 * ------------------------------------------------------------------------ */

/** `--mdv-token: value;` pairs from the first CSS block opened by `selector`.
 *  Matching ignores whitespace differences — the two stylesheets indent their
 *  print selectors differently, and formatting is not an agreement failure. */
function cssTokens(text, selector, label) {
  const collapse = (s) => s.replace(/\s+/g, ' ');
  const needle = collapse(selector);
  let start = -1;
  for (let i = text.indexOf(':root'); i !== -1; i = text.indexOf(':root', i + 1)) {
    if (collapse(text.slice(i, i + selector.length * 2)).startsWith(needle)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    failures.push(`${label}: block not found — "${needle}"`);
    return null;
  }
  const open = text.indexOf('{', start);
  const close = text.indexOf('}', open);
  const tokens = {};
  for (const [, name, value] of text
    .slice(open, close)
    .matchAll(/--mdv-([a-z-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

/** The default preset's palette for one polarity, parsed out of the TS source. */
function presetTokens(text, polarity) {
  const preset = text.slice(text.indexOf("id: 'default'"));
  const start = preset.indexOf(`${polarity}: {`);
  const close = preset.indexOf('}', start);
  const tokens = {};
  for (const [, name, value] of preset
    .slice(start, close)
    .matchAll(/'?([a-z-]+)'?:\s*'([^']+)'/g)) {
    tokens[name] = value.trim();
  }
  delete tokens[polarity];
  return tokens;
}

/**
 * Tokens a copy may legitimately omit because it has no rule that reads them:
 * the export styles no scrollbars, so carrying the token would be a value with
 * no consumer. An omission is fine; a *different* value never is.
 */
const OMITTABLE = new Set(['scrollbar']);

function compareTokens(reference, refLabel, candidate, candidateLabel) {
  if (!reference || !candidate) return;
  for (const [name, value] of Object.entries(reference)) {
    if (name === 'color-scheme') continue;
    if (!(name in candidate) && OMITTABLE.has(name)) continue;
    if (!(name in candidate)) {
      failures.push(`${candidateLabel}: missing --mdv-${name} (defined in ${refLabel})`);
    } else if (candidate[name] !== value) {
      failures.push(
        `${candidateLabel}: --mdv-${name} is ${candidate[name]}, but ${refLabel} says ${value}`,
      );
    }
  }
  for (const name of Object.keys(candidate)) {
    if (!(name in reference)) {
      failures.push(`${candidateLabel}: --mdv-${name} has no counterpart in ${refLabel}`);
    }
  }
}

const viewerCss = readFileSync('entrypoints/viewer.css', 'utf8');
const exportTs = readFileSync('lib/export.ts', 'utf8');
const presetsTs = readFileSync('lib/theme-presets.ts', 'utf8');

for (const polarity of ['light', 'dark']) {
  const source = presetTokens(presetsTs, polarity);
  const selector = `:root[data-mdv-theme='${polarity}']`;
  compareTokens(
    source,
    `theme-presets default ${polarity}`,
    cssTokens(viewerCss, selector, `viewer.css ${polarity}`),
    `viewer.css ${polarity}`,
  );
  compareTokens(
    source,
    `theme-presets default ${polarity}`,
    cssTokens(exportTs, selector, `EXPORT_CSS ${polarity}`),
    `EXPORT_CSS ${polarity}`,
  );
}

// Print exists only in the two stylesheets; viewer.css is the reference. The
// print block deliberately overrides a subset (selection and scrollbar keep
// their screen values), so the comparison is between the two overrides, not
// against the full screen palette.
const printSelector = ":root[data-mdv-theme='light'],\n:root[data-mdv-theme='dark']";
const viewerPrint =
  cssTokens(viewerCss.slice(viewerCss.indexOf('@media print')), printSelector, 'viewer.css print') ??
  undefined;
const exportPrint =
  cssTokens(
    exportTs.slice(exportTs.indexOf('@media print')),
    ":root[data-mdv-theme='light'], :root[data-mdv-theme='dark']",
    'EXPORT_CSS print',
  ) ?? undefined;
compareTokens(viewerPrint, 'viewer.css print', exportPrint, 'EXPORT_CSS print');

if (failures.length > 0) {
  console.error(`✖ ${failures.length} design-token violation(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`✔ design tokens hold across ${files.length} governed file(s)`);
