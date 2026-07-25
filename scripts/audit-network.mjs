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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

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
];

/** Anything here can open a connection or pull a resource; always a failure. */
const NETWORK_APIS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /sendBeacon/,
  /\bimportScripts\s*\(/,
  /\bnew\s+FontFace\b/,
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

/**
 * CSS-only checks. `@font-face` appears in JS as a highlight.js grammar keyword
 * for highlighting CSS source, which loads nothing — but in an actual
 * stylesheet it means a webfont, so the check is scoped to where it matters.
 */
const CSS_RULES = [
  [/@font-face/, 'webfont declaration'],
  [/@import/, 'external stylesheet import'],
  [/url\(\s*['"]?https?:/, 'remote resource in url()'],
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const failures = [];
const notices = [];

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
  }

  for (const url of new Set(text.match(/https?:\/\/[^\s'"`)\\]+/g) ?? [])) {
    const inert = INERT_URLS.find(([prefix]) => url.startsWith(prefix));
    if (inert) notices.push(`${file}: ${url} — ${inert[1]}`);
    else failures.push(`${file}: unclassified external URL ${url}`);
  }
}

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
