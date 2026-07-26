/**
 * Scroll memory, as a plugin.
 *
 * Two things the shell used to decide move here. The `rememberScroll` setting
 * is gone — whether a document remembers where you were is this plugin's
 * enabled state, the same bargain the sidebar made with `showToc`. And the
 * `ready` flag is now read off the shared document: the raw view has none of
 * the headings positions are measured against, so restoring into it would land
 * nowhere meaningful.
 *
 * The URL comes from `ctx.document.url`, never `location.href`. They are not
 * the same thing: the files plugin can open a document read through a directory
 * handle, which has no page URL of its own, and keying that document's position
 * on the tab's address would file every file in the folder under one entry.
 */

import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';
import { startScrollMemory } from './state.ts';

export const scrollMemoryPlugin: Plugin = {
  id: 'scroll-memory',
  name: 'Scroll memory',
  description:
    'Returns you to where you stopped reading. Positions are stored per document and expressed against headings, so they survive a font-size change or an edit.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  setup(ctx) {
    /** What the running session is keyed on, so a re-render does not restart it. */
    let active: string | null = null;
    let stop: Teardown = () => {};

    const sync = () => {
      const url = ctx.document.url;
      // The raw view is not measurable, and a document with no URL is not
      // storable. Either way: stop, and start again when that changes.
      const wanted = url !== '' && !ctx.document.isRaw ? url : null;
      if (wanted === active) return;

      stop();
      stop = () => {};
      active = wanted;
      if (wanted !== null) stop = startScrollMemory(wanted);
    };

    const unwatch = ctx.document.onChange(sync);
    sync();

    return () => {
      unwatch();
      stop();
      stop = () => {};
      active = null;
    };
  },
};
