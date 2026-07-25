import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Markdown Viewer',
    description: 'Renders .md files in the browser instead of showing raw text.',
    // No host permissions at install time. `activeTab` covers click-to-render
    // on the current tab, and anything persistent is requested per-origin at
    // runtime out of `optional_host_permissions`.
    permissions: ['storage', 'activeTab', 'scripting'],
    optional_host_permissions: ['*://*/*'],
  },
  vite: () => ({
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
