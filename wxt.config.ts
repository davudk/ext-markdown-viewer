import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Markdown Viewer',
    description: 'Renders .md files in the browser instead of showing raw text.',
    // Lets Chrome offer the "Allow access to file URLs" toggle, which the user
    // must enable manually before local .md files render.
    host_permissions: ['file:///*'],
  },
});
