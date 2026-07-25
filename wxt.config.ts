import { defineConfig } from 'wxt';

/**
 * Keeps KaTeX out of every bundle except the add-on that renders with it.
 *
 * `lib/markdown.ts` keeps `@vscode/markdown-it-katex` for its *tokenizer* and
 * replaces its renderer rules with placeholders, so nothing in the pipeline
 * calls KaTeX any more. That is not enough on its own: the plugin is CommonJS
 * and does `require("katex")` at module scope, then reads it through
 * `options.katex ?? katex_1.default` — a live reference the bundler cannot drop,
 * whatever the renderer rules end up being. Overriding the rules without this
 * leaves renderer.js the same size it was.
 *
 * So the fallback is cut at resolution time, and only for that one importer:
 * `entrypoints/katex-addon.ts` imports `katex` directly and still gets the real
 * one. The stub can never be reached at runtime — the rules it would have
 * served are the ones `deferMathRendering` replaced — and it throws rather than
 * returning markup, so "reached anyway" is a loud failure and not a silent
 * blank formula.
 */
const KATEX_STUB = '\0mdv:katex-not-in-the-parser';

function katexRenderingIsAnAddon() {
  return {
    name: 'mdv:katex-rendering-is-an-addon',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      const fromThePlugin = importer?.includes('markdown-it-katex') ?? false;
      return source === 'katex' && fromThePlugin ? KATEX_STUB : null;
    },
    load(id: string) {
      if (id !== KATEX_STUB) return null;
      return `export default { renderToString() {
        throw new Error('math is rendered by the KaTeX add-on, not the parser');
      } };`;
    },
  };
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Markdown Viewer',
    description: 'Renders .md files in the browser instead of showing raw text.',
    // No host permissions at install time. `activeTab` covers click-to-render
    // on the current tab, and anything persistent is requested per-origin at
    // runtime out of `optional_host_permissions`.
    permissions: ['storage', 'activeTab', 'scripting', 'downloads'],
    optional_host_permissions: ['*://*/*'],
    // KaTeX's stylesheet is injected into the page, and Chrome resolves its
    // `url(../fonts/…)` against the extension. Without this the fonts are
    // silently refused and math renders in whatever the browser guesses —
    // a wrong-typeface failure with no error anywhere.
    web_accessible_resources: [
      {
        resources: ['fonts/*.woff2'],
        matches: ['<all_urls>'],
      },
    ],
  },
  vite: () => ({
    plugins: [katexRenderingIsAnAddon()],
    // Deliberately no `esbuild: { charset: 'ascii' }` here. Chromium refuses
    // any extension file containing a Unicode noncharacter — KaTeX's lexer has
    // a literal U+FFFF — and that setting looks like the fix but is silently
    // ignored under Vite's Rolldown backend: adding it leaves the emitted bytes
    // identical, verified by rebuilding with and without. The real fix runs
    // after the build, in `scripts/fix-noncharacters.mjs`, which is part of
    // `npm run build`; `check:build` fails if it is ever skipped.
    build: {
      // Vite's module-preload polyfill emits a `fetch()` to warm preload links.
      // It only ever requests same-origin extension resources, but the zero-
      // network guarantee is easier to audit — and to trust — when the built
      // bundle contains no fetch call at all. Everything is bundled anyway, so
      // there is nothing left for it to preload.
      modulePreload: false,
    },
  }),
});
