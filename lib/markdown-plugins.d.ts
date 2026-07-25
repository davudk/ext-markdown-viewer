/**
 * Types for the markdown-it plugins that ship none.
 *
 * Narrowed to the surface `lib/markdown.ts` actually uses rather than
 * transcribed from each README: an option this file does not name is an option
 * the pipeline does not set, and a wider declaration would only make it easier
 * to set one by accident. Everything else in the plugin set carries its own
 * types and is imported normally.
 */

declare module 'markdown-it-container' {
  import type { PluginWithParams } from 'markdown-it';

  const container: PluginWithParams;
  export default container;
}

declare module 'markdown-it-emoji' {
  import type { PluginWithOptions } from 'markdown-it';

  /** Shortnames plus ASCII shortcuts; `light` is a reduced set we do not use. */
  export const full: PluginWithOptions<{
    defs?: Record<string, string>;
    shortcuts?: Record<string, string | string[]>;
    enabled?: string[];
  }>;
}

declare module 'markdown-it-footnote' {
  import type { PluginSimple } from 'markdown-it';

  const footnote: PluginSimple;
  export default footnote;
}
