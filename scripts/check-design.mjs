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

if (failures.length > 0) {
  console.error(`✖ ${failures.length} design-token violation(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`✔ design tokens hold across ${files.length} governed file(s)`);
