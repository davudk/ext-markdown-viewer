/**
 * Proves the zero-network guarantee against the *built* bundle, not the source.
 * Run after `npm run build`. Exits non-zero on any failure.
 *
 * Two severities, because "this string contains a URL" and "this code makes a
 * request" are different claims:
 *
 *   FAIL   — anything that can actually open a connection or load a resource.
 *   NOTICE — an external URL that is only ever a string literal (library error
 *            messages, XML namespaces). Printed every run rather than silently
 *            allowlisted, so a new one has to be looked at and classified.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const OUT = '.output/chrome-mv3';

/** URL prefixes verified to be inert string constants, with the reason why. */
const INERT_URLS = [
  ['http://www.w3.org/', 'XML/SVG namespace constants compared by DOMPurify'],
  ['https://www.w3.org/', 'XML/SVG namespace constants'],
  ['http://www.mozilla.org/', 'MPL license header text'],
  ['https://html.spec.whatwg.org/', 'spec reference in a comment or error string'],
  ['https://react.dev/errors/', 'React minified-invariant help URL'],
  ['https://github.com/highlightjs/', 'highlight.js error and deprecation messages'],
  ['https://github.com/markedjs/', 'marked error messages'],
  ['https://github.com/mermaid-js/', 'mermaid deprecation notice text'],
  ['https://chevrotain.io/', "chevrotain lexer-error messages ('See ... for details')"],
  ['https://github.com/chevrotain/', 'chevrotain bug-report links in error text'],
  ['https://mermaid.js.org/', 'mermaid documentation links in error text'],
  ['https://katex.org/', 'KaTeX error and documentation links'],
  ['https://langium.org/', 'langium cyclic-dependency error message'],
  [
    'https://github.com/valeriangalliat/markdown-it-anchor',
    'markdown-it-anchor deprecation message for its legacy permalink option',
  ],
  ['https://en.wikipedia.org/', 'left-recursion explanation in a langium grammar error'],
  [
    'http://schemas.openxmlformats.org/',
    'OOXML namespace and relationship-type constants written into the .docx package',
  ],
  [
    'http://schemas.microsoft.com/office/',
    'Word/Office extension namespaces docx declares on the document root',
  ],
  ['http://purl.org/dc/', 'Dublin Core namespaces in the .docx core-properties part'],
  ['https://answers.microsoft.com/', "docx error message about Word's nine list levels"],
  ['https://stuk.github.io/jszip/', 'JSZip error message text'],
  [
    'https://rolldown.rs/',
    "the bundler's CJS-interop error string for an unresolved require; no node builtins are required, so it is unreachable",
  ],
];

/**
 * Anything here can open a connection or pull a resource; always a failure.
 *
 * `fetch` and `new FontFace` are deliberately absent, for the same reason. Live
 * reload re-reads the open document's own address and the KaTeX add-on loads
 * fonts out of the extension's own package; both are real resource loads, and
 * neither can be told apart from "phones home" by pattern-matching minified
 * output — the URL is a variable by then. They are policed against the *source*
 * tree instead — see `auditCallSites` below — which is stricter, because it
 * fails on a new call site rather than on a string that happens to look like one.
 */
const NETWORK_APIS = [
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /sendBeacon/,
  /\bimportScripts\s*\(/,
];

/**
 * Network-adjacent APIs that read state without requesting anything. Reported
 * so they stay visible, since a future one might not be so innocent.
 */
const INERT_APIS = [
  [
    /navigator\.connection/,
    'React reads connection.downlink to size its own resource-loading heuristics; nothing is sent',
  ],
];

/** CSS-only checks. Per-`url()` inspection is handled separately below. */
const CSS_RULES = [[/@import\s+(?:url\()?\s*['"]?(?:https?:)?\/\//, 'remote stylesheet import']];

/**
 * Every `url()` in a stylesheet, checked two ways.
 *
 * A blanket ban on `@font-face` was the original rule, and it was wrong: KaTeX
 * ships its own woff2 files, and a font bundled *inside* the extension is a
 * disk read, not a request. What actually matters is where the URL points — and,
 * just as importantly, that a local one resolves to a file that exists, since a
 * bundled font that failed to get copied produces no build error and no runtime
 * error, only unreadable glyphs.
 */
function auditStylesheetUrls(file, text) {
  const relative = file.slice(OUT.length + 1);

  for (const [, raw] of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const url = raw.trim();

    if (url.startsWith('data:')) continue;

    if (/^(https?:)?\/\//.test(url)) {
      failures.push(`${relative}: remote resource in url() — ${url}`);
      continue;
    }

    // Extension-relative, so resolve it the way the browser will: against the
    // stylesheet's own location inside the packed extension.
    const resolved = join(dirname(file), url.split(/[?#]/)[0]);
    if (!existsSync(resolved)) {
      failures.push(
        `${relative}: url() points at a file missing from the build — ${url}`,
      );
    }
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const failures = [];
const notices = [];

/**
 * Blanks out comments and string bodies so a call site is counted only where it
 * is actually code. Without this, a comment discussing `fetch(` inflates the
 * count — which matters in both directions: it reads as a call that isn't
 * there, and it hides a real one behind an already-nonzero number.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let state = 'code';
  let quote = '';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; i += 1; continue; }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; i += 1; continue; }
      if (char === '"' || char === "'" || char === '`') { state = 'string'; quote = char; out += char; continue; }
      out += char;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += char; continue; }
      out += ' ';
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; i += 1; continue; }
      out += char === '\n' ? char : ' ';
      continue;
    }

    // In a string: a backslash escapes whatever follows, including the quote.
    if (char === '\\') { out += '  '; i += 1; continue; }
    if (char === quote) { state = 'code'; out += char; continue; }
    out += ' ';
  }

  return out;
}

/**
 * Every call site of a resource-fetching API in the source, checked against the
 * matching allowlist in lib/config.ts. This is the real guard on the network
 * claim: the built bundle cannot distinguish "re-reads the open document" from
 * "phones home", but the source can, and a new call site anywhere fails the
 * build.
 */
function auditCallSites(label, pattern, allowlist) {
  const config = readFileSync('lib/config.ts', 'utf8');
  const declared = config.match(
    new RegExp(`^export const ${allowlist} = \\[([^\\]]*)\\];$`, 'm'),
  );

  if (!declared) {
    failures.push(`could not read ${allowlist} from lib/config.ts`);
    return;
  }

  const allowed = new Set(
    [...declared[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
  );

  // `plugins` is in this list because it was once missing from it: features
  // moved out of `components` into plugin folders, and a request made from one
  // would have been entirely unpoliced — the opposite of what the guard claims.
  const sources = ['lib', 'entrypoints', 'components', 'plugins']
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => walk(dir).filter((file) => /\.tsx?$/.test(file)));

  for (const file of sources) {
    const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    const calls = (code.match(pattern) ?? []).length;
    if (calls === 0) continue;

    if (allowed.has(file)) {
      notices.push(`${file}: ${calls} allowlisted ${label} call site(s)`);
    } else {
      failures.push(`${file}: ${label} outside ${allowlist} (${calls} call site(s))`);
    }
  }

  for (const file of allowed) {
    if (!sources.includes(file)) {
      failures.push(`${allowlist} names a file with no ${label} left in it: ${file}`);
    }
  }
}

for (const file of walk(OUT)) {
  if (!['.js', '.css', '.html', '.json'].includes(extname(file))) continue;
  const text = readFileSync(file, 'utf8');

  for (const pattern of NETWORK_APIS) {
    const match = text.match(pattern);
    if (match) failures.push(`${file}: ${match[0]}`);
  }

  for (const [pattern, reason] of INERT_APIS) {
    const match = text.match(pattern);
    if (match) notices.push(`${file}: ${match[0]} — ${reason}`);
  }

  if (extname(file) === '.css') {
    for (const [pattern, label] of CSS_RULES) {
      if (pattern.test(text)) failures.push(`${file}: ${label}`);
    }
    auditStylesheetUrls(file, text);
  }

  for (const url of new Set(text.match(/https?:\/\/[^\s'"`)\\]+/g) ?? [])) {
    // A template interpolation is a URL *shape*, not an address: `http://${x}`
    // builds a string at runtime and names no endpoint. Matching the literal
    // would also be brittle — the minified identifier inside changes per build.
    if (url.includes('${')) continue;

    const inert = INERT_URLS.find(([prefix]) => url.startsWith(prefix));
    if (inert) notices.push(`${file}: ${url} — ${inert[1]}`);
    else failures.push(`${file}: unclassified external URL ${url}`);
  }
}

auditCallSites('fetch', /(?<![.\w])fetch\s*\(/g, 'FETCH_ALLOWLIST');
auditCallSites('new FontFace', /\bnew\s+FontFace\b/g, 'FONT_FACE_ALLOWLIST');

if (notices.length > 0) {
  console.log(`${notices.length} inert URL string(s):`);
  for (const notice of notices) console.log(`  · ${notice}`);
  console.log();
}

if (failures.length > 0) {
  console.error(`✖ ${failures.length} network finding(s):\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`✔ no network calls or loadable external resources in ${OUT}`);
