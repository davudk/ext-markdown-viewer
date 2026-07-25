/**
 * Asserts the built extension is internally consistent. Run after `npm run build`.
 *
 * The specific bug this exists to catch: the renderer and its stylesheet are
 * injected by path string, so a build-output rename (WXT moving CSS entrypoints
 * under `assets/`, say) breaks injection at runtime with a clean build and a
 * clean typecheck. Nothing else would notice.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.output/chrome-mv3';
const problems = [];

// Read the injected paths from source rather than duplicating them here.
const messages = readFileSync('lib/messages.ts', 'utf8');
const injected = [...messages.matchAll(/^export const RENDERER_\w+ = '([^']+)';$/gm)]
  .map((match) => match[1]);

if (injected.length !== 2) {
  problems.push(`expected 2 RENDERER_* constants in lib/messages.ts, found ${injected.length}`);
}

for (const file of injected) {
  if (!existsSync(join(OUT, file))) {
    problems.push(`injected file missing from build output: ${file}`);
  }
}

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));

if (manifest.content_scripts) {
  problems.push('manifest declares static content_scripts; registration must be runtime-only');
}

if (manifest.host_permissions?.length) {
  problems.push(`manifest requests host permissions at install time: ${manifest.host_permissions}`);
}

for (const required of ['storage', 'activeTab', 'scripting']) {
  if (!manifest.permissions?.includes(required)) {
    problems.push(`manifest missing required permission: ${required}`);
  }
}

for (const extra of manifest.permissions ?? []) {
  if (!['storage', 'activeTab', 'scripting'].includes(extra)) {
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
