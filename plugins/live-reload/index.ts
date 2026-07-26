/**
 * Live reload, as a plugin.
 *
 * The poller itself stays in `lib/live-reload.ts`: it is the extension's only
 * `fetch`, and `scripts/audit-network.mjs` walks `lib`, `entrypoints` and
 * `components` but not `plugins`. Making the request from this folder would
 * take it out of the audit's reach — the opposite of what moving it should
 * mean. So the plugin owns when polling runs and stops; the request stays where
 * it can be policed.
 *
 * Off by default, unchanged: it is the one feature that talks to a server.
 *
 * Two things the shell used to decide are now derived here. `opened === null`
 * is gone — `liveReloadTarget` already refuses any URL that is not the page's
 * own, and a file read through a directory handle carries an `mdv-folder:` URL,
 * so it declines itself. And the `liveReload` setting is gone: whether polling
 * happens is this plugin's enabled state and nothing else.
 */

import { startLiveReload } from '../../lib/live-reload.ts';
import { PLUGIN_API_VERSION, type Plugin, type Teardown } from '../../lib/plugins/types.ts';

/**
 * How a new revision reaches the screen.
 *
 * The rendered source is shell state (`pageSource` in `Viewer.tsx`), and the
 * shell is not a plugin — it publishes what it can do onto the host's
 * capability store, exactly as it already does for `document.open`. Declaring
 * the capability here rather than importing anything from the shell is the
 * whole point: absence is a normal state, and while the shell has not mounted
 * this plugin simply does not poll.
 */
declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    /** Replace the page document's source with a freshly read revision. */
    'document.reload': (source: string) => void;
  }
}

export const liveReloadPlugin: Plugin = {
  id: 'live-reload',
  name: 'Live reload',
  description:
    "Re-reads the open file on a timer and re-renders it when it changes. The only feature that makes a network request, and only ever for the document's own address.",
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: false,

  setup(ctx) {
    /** The address currently being polled, so a re-render does not restart it. */
    let polling: string | null = null;
    let stop: Teardown = () => {};

    const sync = () => {
      const url = ctx.document.url;
      const apply = ctx.capabilities.use('document.reload');

      // Nothing to hand a new revision to yet. Poll once the shell is there.
      if (!apply || url === '') {
        stop();
        stop = () => {};
        polling = null;
        return;
      }

      if (url === polling) return;

      stop();
      polling = url;
      stop = startLiveReload({
        url,
        source: ctx.document.source,
        onChange: (source) => ctx.capabilities.use('document.reload')?.(source),
      });
    };

    const watchers = [ctx.document.onChange(sync), ctx.capabilities.onChange(sync)];
    sync();

    // The stranded timer this returns is the exact leak the teardown contract
    // exists to catch: a poll rescheduled after disable would keep requesting
    // forever, with no feature on screen to explain it.
    return () => {
      for (const off of watchers) off();
      stop();
      stop = () => {};
      polling = null;
    };
  },
};
