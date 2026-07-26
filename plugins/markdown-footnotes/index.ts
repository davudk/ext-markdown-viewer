/**
 * `Text[^1]` and its definition at the foot of the document.
 *
 * The thinnest markdown plugin there is: one `md.use`, no rule ordering, no
 * shared state. Disabled, `[^1]` is the literal text it was in the source —
 * which is the property every plugin in this family is tested for.
 */

import footnote from 'markdown-it-footnote';
import type MarkdownIt from 'markdown-it';

import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const markdownFootnotesPlugin: Plugin = {
  id: 'markdown-footnotes',
  name: 'Footnotes',
  description: 'Renders `[^1]` references and their definitions.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.use(footnote);
  },
};
