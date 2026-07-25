/**
 * Proves the zero-network guarantee against the *built* bundle, not the source.
 * Run after `npm run build`. Exits non-zero on any finding.
 *
 * Namespace URIs are allowlisted: DOMPurify and SVG handling legitimately
 * compare against them as string constants, and they are never fetched.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '.output/chrome-mv3';

const ALLOWED_URLS = [
  'http://www.w3.org/',
  'https://www.w3.org/',
  'http://www.mozilla.org/',
  'https://html.spec.whatwg.org/',
];

const NETWORK_APIS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /sendBeacon/,
  /\bimportScripts\s*\(/,
  /@font-face/,
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const findings = [];

for (const file of walk(OUT)) {
  if (!/\.(js|css|html|json)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');

  for (const pattern of NETWORK_APIS) {
    const match = text.match(pattern);
    if (match) findings.push({ file, kind: 'api', detail: match[0] });
  }

  for (const url of text.match(/https?:\/\/[^\s'"`)\\]+/g) ?? []) {
    if (ALLOWED_URLS.some((prefix) => url.startsWith(prefix))) continue;
    findings.push({ file, kind: 'url', detail: url });
  }
}

if (findings.length === 0) {
  console.log('✔ no network calls or external URLs in', OUT);
  process.exit(0);
}

console.error(`✖ ${findings.length} finding(s):\n`);
for (const { file, kind, detail } of findings) {
  console.error(`  [${kind}] ${file}\n        ${detail}`);
}
process.exit(1);
