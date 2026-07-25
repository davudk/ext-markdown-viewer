/**
 * Escapes Unicode noncharacters and unpaired surrogates in the built JavaScript.
 *
 * Chromium validates every extension file with `base::IsStringUTF8`, which is
 * stricter than "decodes as UTF-8": it also rejects surrogates and the Unicode
 * noncharacters (U+FDD0–U+FDEF, and U+xFFFE/U+xFFFF in every plane). KaTeX's
 * lexer carries a literal U+FFFF inside a regex character class, so the bundle
 * was byte-perfect UTF-8 and Chrome still refused to load it:
 *
 *     Could not load file 'renderer.js'. It isn't UTF-8 encoded.
 *
 * Replacing the character with its `￿` escape yields an identical string at
 * runtime — the JS engine unescapes it — while the file on disk stays ASCII in
 * that region.
 *
 * This runs on the emitted files rather than as a bundler plugin on purpose.
 * esbuild's `charset: 'ascii'` is ignored under Vite's Rolldown backend, and a
 * `generateBundle` plugin never reached the output because WXT drives a separate
 * Vite build per entrypoint. Post-processing the directory is the one place that
 * is true regardless of how the toolchain changes underneath.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = '.output';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function isNoncharacter(codePoint) {
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return true;
  return (codePoint & 0xfffe) === 0xfffe;
}

function escapeUnit(unit) {
  return `\\u${unit.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Returns escaped source and a count, or null when nothing needed changing. */
export function escapeNoncharacters(code) {
  let out = '';
  let count = 0;

  for (let i = 0; i < code.length; i += 1) {
    const unit = code.charCodeAt(i);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;

    if (isHigh && i + 1 < code.length) {
      const next = code.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        if (isNoncharacter(codePoint)) {
          // Both halves: an astral noncharacter has no single-unit escape.
          out += escapeUnit(unit) + escapeUnit(next);
          count += 1;
        } else {
          out += code[i] + code[i + 1];
        }
        i += 1;
        continue;
      }
    }

    // A lone surrogate is refused for the same reason a noncharacter is.
    if (isHigh || isLow || isNoncharacter(unit)) {
      out += escapeUnit(unit);
      count += 1;
      continue;
    }

    out += code[i];
  }

  return count > 0 ? { code: out, count } : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let patched = 0;

  for (const file of walk(ROOT)) {
    if (!file.endsWith('.js')) continue;
    const result = escapeNoncharacters(readFileSync(file, 'utf8'));
    if (!result) continue;

    writeFileSync(file, result.code, 'utf8');
    patched += 1;
    console.log(`  escaped ${result.count} character(s) in ${relative(ROOT, file)}`);
  }

  console.log(
    patched === 0
      ? '✔ no Unicode noncharacters in the build'
      : `✔ escaped Unicode noncharacters in ${patched} file(s)`,
  );
}
