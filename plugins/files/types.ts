/**
 * The two shapes the folder browser hands to other people.
 *
 * In their own module rather than beside the component because the component is
 * a `.tsx` file, and both the shell and the search tab need these types without
 * pulling a React tree — the bare test runner cannot load a `.tsx` at all.
 */

import type { PaletteFile } from '../../lib/commands.ts';
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

/**
 * What the open folder can do, for anyone who is not in the tree.
 *
 * This replaces the module-scope registry that used to live at the bottom of
 * `lib/commands.ts`: one publisher, one subscriber, and a `let` at module scope
 * that outlived every component involved. It was written when the palette was a
 * sibling of the sidebar with two forwarding components in between — which is
 * precisely the problem capabilities exist to solve, so it is one now. Nothing
 * else about it changes: the same five things are published, at the same moment,
 * and reset the same way when the tab unmounts.
 *
 * `read` is the one addition. The command palette's "Compare files…" row was
 * dead code — the shell had no handler to pass — and making it real needs the
 * text of a file the reader picks, which only this side can get to.
 */
export interface FolderBrowserHandle {
  /** False where the File System Access API is missing; removes "Open folder…". */
  supported: boolean;
  /** The open folder's name, or null when none is. */
  rootName: string | null;
  /** Markdown files in the directories read so far. `id` is the relative path. */
  files: readonly PaletteFile[];
  /** Opens the picker. */
  choose: () => void;
  /** Opens one of `files`, by its `id`. */
  open: (id: string) => void;
  /** Reads one of `files` without opening it. Rejects when it is gone. */
  read: (id: string) => Promise<string>;
}

export const NO_FOLDER: FolderBrowserHandle = {
  supported: false,
  rootName: null,
  files: [],
  choose: () => {},
  open: () => {},
  read: () => Promise.reject(new Error('no folder is open')),
};

/**
 * A `Store` for the same reason `files.status` is one: a capability's identity
 * only changes when it is provided or withdrawn, and this changes — a directory
 * is expanded, a folder is closed — while the plugin stays enabled.
 */
export type FolderBrowserStore = Store<FolderBrowserHandle>;

declare module '../../lib/plugins/types.ts' {
  interface Capabilities {
    'files.status': FolderStatusHandle;
    'files.browser': FolderBrowserStore;
  }
}
