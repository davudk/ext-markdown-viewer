# Markdown Viewer

A Chrome extension that renders Markdown files in the browser instead of showing
raw text. Free, no payment model, no accounts, no telemetry.

## Principles

These are decided once and apply to everything:

- **No permissions at install time.** Host access is optional, requested
  per-origin, and only ever in response to a user action.
- **Zero network calls.** No analytics, no telemetry, no webfonts, no CDNs.
  Every library is bundled. This is enforced by a build check, not a promise —
  see [Verifying the zero-network claim](#verifying-the-zero-network-claim).
- **Local state only.** Everything lives in `chrome.storage.local`. Never
  `chrome.storage.sync`, which round-trips through Google's servers.
- **Manifest V3**, with a stateless service worker.
- **Reproducible builds** from a public repo.

## Requirements

Node `>=20.19.0` (see [.nvmrc](.nvmrc)). Dependencies are pinned to exact
versions and `package-lock.json` is committed, so `npm ci` reproduces the same
tree on any machine.

## Build

```bash
npm ci
npm run build
```

Output lands in `.output/chrome-mv3/`. For a Web Store archive:

```bash
npm run zip
```

## Develop

```bash
npm run dev
```

Launches a separate Chrome instance with the extension loaded and hot reloading
enabled. Edits to source apply without reinstalling.

## Install manually

1. `npm run build`
2. Open `chrome://extensions` and enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3`

## How permissions work

Chrome offers no way for an extension to register a content-type handler, so a
Markdown viewer has to inject itself into a page Chrome has already decided to
render as plain text. Most viewers solve this by declaring a static content
script over `<all_urls>`, which forces the user to grant "read and change all
your data on all websites" at install time.

This one declares no host permissions at all. Instead:

| Tier | Trigger | Mechanism | Prompt? |
| --- | --- | --- | --- |
| Render this page | Opening the popup and clicking | `activeTab` | None |
| Always on this site | Explicit opt-in per origin | `permissions.request()` → `scripting.registerContentScripts()` | Chrome's standard grant dialog |

Tier 1 covers the common case with no dialog whatsoever. Tier 2 exists only for
people who want a site to render automatically on future visits, and it can be
revoked from the same popup.

The service worker never tracks what it registered. It derives registrations
entirely from `chrome.permissions.getAll()`, so granted state and registered
state cannot drift, and revoking an origin genuinely stops the injection.

### Local files are different

`file:///*` cannot be requested at runtime — Chrome does not accept it through
`permissions.request()`. The **Allow access to file URLs** toggle on the
extension's details page is the only mechanism that exists. The extension
detects the current state with `chrome.extension.isAllowedFileSchemeAccess()`
and explains what to do; it cannot enable it for you.

## Verifying the zero-network claim

```bash
npm run build
node scripts/audit-network.mjs
```

Scans the built output for `fetch`, `XMLHttpRequest`, `WebSocket`,
`EventSource`, `sendBeacon`, `importScripts`, `@font-face`, and any external
URL. Exits non-zero on a finding. W3C/WHATWG namespace URIs are allowlisted —
DOMPurify compares against them as string constants and never requests them.

## Known limits

- `.md` URLs served with `Content-Disposition: attachment` (raw GitHub among
  them) download instead of rendering. No content script can intercept that.
- `.mdx` is rendered as plain GFM. JSX components in the file will not render;
  proper MDX support needs a JSX parser and is out of scope.
- Sites that render Markdown themselves (GitHub blob views, GitBook,
  ReadTheDocs) are excluded by design.

## Layout

```
entrypoints/background.ts    service worker: permissions → script registration
entrypoints/renderer.tsx     the page takeover, injected dynamically
entrypoints/viewer.css       document styles, light + dark
entrypoints/popup/           toolbar popup: permissions and theme
lib/detect.ts                activation rules
lib/markdown.ts              marked + highlight.js + DOMPurify
lib/settings.ts              chrome.storage.local
lib/messages.ts              popup ↔ service worker contract
scripts/audit-network.mjs    zero-network build check
test/fixtures/               rendering and sanitization fixtures
```

## Scope

This is a viewer. Editing, WYSIWYG, accounts, sync, cloud storage, AI features,
and analytics are all explicitly out of scope.

## License

MIT
