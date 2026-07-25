# Markdown Viewer

A Chrome extension that renders `.md` files in the browser instead of showing raw text.

Built with [WXT](https://wxt.dev) + React.

## Development

```bash
npm run dev
```

This launches a Chrome instance with the extension loaded and hot-reloading enabled.

## Build

```bash
npm run build   # outputs to .output/chrome-mv3
npm run zip     # produces a Web Store-ready archive
```

## Loading manually

1. `npm run build`
2. Go to `chrome://extensions`, enable **Developer mode**
3. **Load unpacked** → select `.output/chrome-mv3`
4. For local files, open the extension's **Details** page and enable
   **Allow access to file URLs**

## How it works

Chrome gives extensions no way to register a content-type handler, so the
extension can't intercept `.md` before Chrome decides what to do with it.
Instead, [entrypoints/content.tsx](entrypoints/content.tsx) runs at
`document_start` on URLs ending in `.md` / `.markdown`, hides the page to avoid
a flash of raw text, then swaps in the rendered view once the document is
parsed.

Known limits of this approach:

- Local files need the **Allow access to file URLs** permission, granted by hand.
- `.md` URLs served with `Content-Disposition: attachment` (raw GitHub, some
  CDNs) download instead of rendering. Nothing a content script can do.
- Markdown is untrusted input, so the rendered HTML is sanitized with DOMPurify
  before it reaches the DOM — see [lib/markdown.ts](lib/markdown.ts).

## Layout

```
entrypoints/content.tsx   takeover logic for .md pages
entrypoints/popup/        toolbar popup
components/Viewer.tsx     rendered document UI
components/viewer.css     document styles (light + dark)
lib/markdown.ts           marked + DOMPurify pipeline
```
