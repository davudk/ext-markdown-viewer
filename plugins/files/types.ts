/**
 * The two shapes the folder browser hands to other people.
 *
 * In their own module rather than beside the component because the component is
 * a `.tsx` file, and both the shell and the search tab need these types without
 * pulling a React tree — the bare test runner cannot load a `.tsx` at all.
 */

import type { Store } from '../../lib/plugins/registry.ts';

/**
 * A file the reader opened through a handle rather than by address.
 *
 * `url` is the synthetic `mdv-folder:` identity from `lib/folder.ts` — it is
 * what scroll memory keys on and what live reload declines, and it is never a
 * place anything tries to go.
 */
export interface OpenedDocument {
  url: string;
  /** Basename, for a title. */
  name: string;
  /** Path relative to the folder root. */
  path: string;
  source: string;
}

/** What the tab strip is told, so it can say why the tab is empty. */
export type FolderStatus = 'unsupported' | 'idle' | 'ready';

/**
 * Whether a folder is open, published for anyone who needs to know.
 *
 * Search uses it as a change signal: it reads the handle out of storage itself,
 * so this says *when* to look again rather than what is there. A `Store` rather
 * than a plain value because a capability's identity only changes when it is
 * provided or withdrawn, and this changes while the plugin stays enabled.
 */
export type FolderStatusHandle = Store<FolderStatus>;

declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    'files.status': FolderStatusHandle;
  }
}
