/**
 * MultiMarkdown's table extensions: colspan, rowspan, multi-line cells.
 *
 * Only the options that are strict supersets of GFM are on, so a table that
 * parsed before parses identically now — the reasoning for each is in
 * `MULTIMD_TABLE_OPTIONS`.
 *
 * What is deliberately *not* here is the `mdv_table_align` core rule that turns
 * `style="text-align:…"` into `align="…"`. markdown-it's own table rule emits
 * the same inline style, so if that normalisation lived in this plugin then
 * disabling it would leave ordinary GFM tables styled in a way `viewer.css`,
 * the exported stylesheet and the DOCX writer (`lib/export.ts`) do not read —
 * a silent regression in a feature nobody turned off. It stays in
 * `lib/markdown.ts` with the rest of the baseline output contract.
 *
 * Disabled, a table is still a table; only `||` and `^^` stop meaning anything.
 */

import multimdTable from 'markdown-it-multimd-table';
import type MarkdownIt from 'markdown-it';

/**
 * MultiMarkdown table extensions. Only the ones that are strict supersets of
 * GFM are on, so a table that parsed before parses identically now.
 *
 * `multibody` is off because it is not a superset, and the way it fails is
 * silent: it treats a blank line inside a table as a `<tbody>` break, which
 * means two ordinary GFM tables written back to back become one table whose
 * second header row renders as a row of literal `---` cells. Two tables in a
 * row is far commoner in a README than multiple row groups in one.
 *
 * `autolabel` is off for a duller reason: it mints an `id` on every captioned
 * table out of the caption text, in the same namespace as the heading slugs,
 * and nothing in the viewer links to a table.
 */
export const MULTIMD_TABLE_OPTIONS = {
  multiline: true,
  rowspan: true,
  headerless: true,
  multibody: false,
  autolabel: false,
};
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const markdownTablesPlugin: Plugin = {
  id: 'markdown-tables',
  name: 'Extended tables',
  description: 'Column and row spans, multi-line cells, headerless tables.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.use(multimdTable, MULTIMD_TABLE_OPTIONS);
  },
};
