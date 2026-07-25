/**
 * Asserts the built extension is internally consistent. Run after `npm run build`.
 *
 * The specific bug this exists to catch: the renderer and its stylesheet are
 * injected by path string, so a build-output rename (WXT moving CSS entrypoints
 * under `assets/`, say) breaks injection at runtime with a clean build and a
 * clean typecheck. Nothing else would notice.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.output/chrome-mv3';
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Read from source rather than duplicating anything here: lib/config.ts is the
// single home for these, and this check exists to catch it drifting from what
// the build actually emits.
const config = readFileSync('lib/config.ts', 'utf8');

const injected = [
  ...[...config.matchAll(/^export const RENDERER_\w+ = '([^']+)';$/gm)].map((m) => m[1]),
  ...[...config.matchAll(/^export const RENDERER_\w+_FILES = \[([^\]]*)\];$/gm)].flatMap((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((f) => f[1]),
  ),
  // Add-ons are injected on demand rather than alongside the renderer, but they
  // are injected all the same — without this their files read as unreachable.
  ...[...config.matchAll(/js: '([^']+)'/g)].map((m) => m[1]),
  ...[...config.matchAll(/css: \[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((f) => f[1]),
  ),
];

if (injected.length < 2) {
  problems.push(`expected RENDERER_* constants in lib/config.ts, found ${injected.length}`);
}

const declared = config.match(/^export const REQUIRED_PERMISSIONS = \[([^\]]*)\];$/m);
const required = declared
  ? [...declared[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  : [];

if (required.length === 0) {
  problems.push('could not read REQUIRED_PERMISSIONS from lib/config.ts');
}

for (const file of injected) {
  if (!existsSync(join(OUT, file))) {
    problems.push(`injected file missing from build output: ${file}`);
  }
}

/**
 * Nothing emitted may be unreachable.
 *
 * This exists because of a real bug: the React components' stylesheets are
 * bundled by Vite into their own `assets/renderer.css`, which was emitted, was
 * never injected, and produced no build error and no type error — the viewer
 * simply rendered with all of its chrome unstyled. Checking only the files the
 * config names cannot catch that; checking that every emitted file is claimed
 * by something can.
 */
const htmlReferences = new Set(
  walk(OUT)
    .filter((file) => file.endsWith('.html'))
    .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/(?:src|href)="\.?\/?([^"]+)"/g)])
    .map((match) => match[1]),
);

for (const file of walk(OUT)) {
  if (!file.endsWith('.css')) continue;
  const relative = file.slice(OUT.length + 1);
  if (injected.includes(relative) || htmlReferences.has(relative)) continue;
  problems.push(
    `stylesheet is emitted but nothing injects or references it: ${relative}`,
  );
}

/**
 * Chromium refuses any extension file that fails `base::IsStringUTF8`, which
 * rejects surrogates and Unicode noncharacters as well as malformed bytes. The
 * failure mode is total and the message is misleading — "It isn't UTF-8
 * encoded" on a file that decodes perfectly — so it is worth asserting rather
 * than rediscovering. `scripts/fix-noncharacters.mjs` is what keeps this true.
 */
for (const file of walk(OUT)) {
  if (!/\.(js|css|html|json)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');

  for (let i = 0; i < text.length; i += 1) {
    const codePoint = text.codePointAt(i);
    if (codePoint > 0xffff) i += 1;

    const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
    const isNoncharacter =
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xfffe) === 0xfffe;

    if (isSurrogate || isNoncharacter) {
      problems.push(
        `Chrome will refuse this file: U+${codePoint.toString(16).toUpperCase()} at ` +
          `offset ${i} in ${file.slice(OUT.length + 1)} — run scripts/fix-noncharacters.mjs`,
      );
      break;
    }
  }
}

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));

if (manifest.content_scripts) {
  problems.push('manifest declares static content_scripts; registration must be runtime-only');
}

if (manifest.host_permissions?.length) {
  problems.push(`manifest requests host permissions at install time: ${manifest.host_permissions}`);
}

for (const permission of required) {
  if (!manifest.permissions?.includes(permission)) {
    problems.push(`manifest missing required permission: ${permission}`);
  }
}

for (const extra of manifest.permissions ?? []) {
  if (!required.includes(extra)) {
    problems.push(`manifest requests an unexpected permission: ${extra}`);
  }
}

if (problems.length === 0) {
  console.log(`✔ build is consistent (injects ${injected.join(', ')})`);
  process.exit(0);
}

console.error(`✖ ${problems.length} problem(s):\n`);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(1);
