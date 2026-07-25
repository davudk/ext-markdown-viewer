/**
 * Marks links that leave the document.
 *
 * The simplest shape a plugin can have: one enhancement pass, no UI, no
 * capabilities, one setting. It exists first as a pilot precisely because it
 * exercises the smallest possible slice of the API — if this one is awkward,
 * everything larger will be worse.
 *
 * Previously this was a prop threaded from the shell into `Document.tsx`, an
 * effect dependency, and a branch inside another component's enhancement pass.
 * Now it is a file.
 */

// Relative, with explicit extensions, rather than the `@/` alias: plugins are
// unit tested by the bare node runner, which has no bundler to resolve an
// alias. The same rule already applies to everything under `lib/`.
import { clearExternalLinks, markExternalLinks } from '../../lib/links.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

const settings = {
  showIndicator: {
    type: 'boolean',
    default: true,
    label: 'Mark links that leave the document',
    description:
      'A small arrow on links to other sites. In-page anchors and relative links are never marked.',
  },
} as const;

export const externalLinksPlugin: Plugin<typeof settings> = {
  id: 'external-links',
  name: 'External link indicators',
  description: 'Shows which links lead away from the document.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,
  settings,

  setup(ctx) {
    // The host batches this with every other plugin's pass and re-runs it on
    // each render, live reload and raw toggle — so there is no observer here,
    // and no second copy of "find the body" logic.
    const stop = ctx.document.enhance((body) => {
      if (!ctx.settings.showIndicator) return;
      markExternalLinks(body, ctx.document.url);
      // The teardown is the reason `enhance` takes one: the pass added
      // attributes to nodes it does not own, and only it knows which.
      return () => clearExternalLinks(body);
    });

    // Toggling the setting has to re-run the pass; the host reruns on document
    // change, not on settings change, so ask for it explicitly.
    const resubscribe = ctx.onSettingsChange(() => ctx.document.refresh());

    return () => {
      resubscribe();
      stop();
    };
  },
};
