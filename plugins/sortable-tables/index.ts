/**
 * Sortable tables: the plugin, assembled.
 *
 * No JSX here — the control is a `<button>` grafted onto a header cell, not a
 * component — so the seam exists purely to keep the stylesheet import, which
 * only a bundler can resolve, out of the module the bare test runner loads.
 */

import { createSortableTablesPlugin } from './plugin.ts';

import './sortable-tables.css';

export const sortableTablesPlugin = createSortableTablesPlugin();
