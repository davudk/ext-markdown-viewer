/**
 * The contract the sidebar publishes to whatever fills its tabs.
 *
 * A region gives a contribution a place to render and nothing else: the host
 * mounts a plain component with no props, so "are you the tab showing", "your
 * chord just opened you, take focus" and "here is the panel wrapper with the
 * right aria wiring" have nowhere to travel through the API. They travel
 * through this React context instead, and a tab imports it from the plugin
 * whose region it contributes to.
 *
 * That is a plugin importing another plugin, which the API otherwise forbids —
 * but it is a type and a context object with no side effects, and a tab is
 * already inert without its surface. See the report: a region provider needs a
 * way to hand its contributors a scope.
 *
 * `useLiveDocument` and `useCapability` are here for a plainer reason: the host
 * does not provide them. `useDocument()` subscribes to the *status* store, so it
 * never re-renders when the document actually changes, and there is no hook for
 * a capability appearing or disappearing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { usePluginHost } from '../../lib/plugins/react.tsx';
import type { Capabilities, DocumentHandle } from '../../lib/plugins/types.ts';

import type { SidebarSnapshot } from './state.ts';
import type { SidebarApi, SidebarTabReport } from './tabs.ts';

export interface SidebarScopeValue {
  /** Stable for the life of the plugin, so a tab can hold callbacks off it. */
  state: SidebarApi | null;
  snapshot: SidebarSnapshot;
  ids: { tab(key: string): string; panel(key: string): string };
}

/**
 * What a panel sees when it renders outside a sidebar. Not an error: a tab is
 * allowed to exist while its surface does not, and the host will simply never
 * render it.
 */
const DETACHED: SidebarScopeValue = {
  state: null,
  snapshot: {
    expanded: false,
    selected: null,
    focusToken: 0,
    focusedKey: null,
    hints: {},
    blocked: [],
  },
  ids: { tab: (key) => `mdv-tab-${key}`, panel: (key) => `mdv-panel-${key}` },
};

export const SidebarScope = createContext<SidebarScopeValue>(DETACHED);

export interface SidebarTabHandle {
  /** This tab is the one on screen: the panel is selected and the rail is open. */
  visible: boolean;
  /** Non-zero, and rising, only when *this* tab was opened by its own chord. */
  focusToken: number;
  /** Escape: hand the sidebar back to whichever tab was showing before. */
  dismiss: () => void;
  /** Say why this tab is empty, or that it cannot work here at all. */
  report: (report: SidebarTabReport) => void;
}

export function useSidebarTab(key: string): SidebarTabHandle {
  const { state, snapshot } = useContext(SidebarScope);

  return {
    visible: snapshot.expanded && snapshot.selected === key,
    focusToken: snapshot.focusedKey === key ? snapshot.focusToken : 0,
    dismiss: useCallback(() => state?.dismiss(), [state]),
    report: useCallback(
      (report: SidebarTabReport) => state?.report(key, report),
      [state, key],
    ),
  };
}

/**
 * The panel a tab renders into.
 *
 * Rendered by the tab rather than by the sidebar because a region renders its
 * contributions as a flat list with no per-contribution wrapper to hang the
 * `role="tabpanel"` on. Every panel stays mounted while another is showing,
 * hidden rather than unmounted — the outline's scroll-spy has to keep tracking,
 * the folder tree has to keep its opened directories and its permission grant,
 * and Search has to keep the query and the results that go with it.
 */
export function SidebarPanel({ tab, children }: { tab: string; children: ReactNode }) {
  const { snapshot, ids } = useContext(SidebarScope);

  return (
    <div
      id={ids.panel(tab)}
      className="mdv-side-panel"
      role="tabpanel"
      aria-labelledby={ids.tab(tab)}
      hidden={snapshot.selected !== tab}
    >
      {children}
    </div>
  );
}

/**
 * The shared document, re-rendering when it changes.
 *
 * `useDocument()` returns the handle but subscribes to the host's *status*
 * store, which only moves when a plugin is enabled or disabled — so a component
 * reading `headings` off it never learns that the document was re-parsed, live
 * reloaded, or switched to raw. Every UI plugin needs this; today every UI
 * plugin has to write it.
 */
export function useLiveDocument(): DocumentHandle {
  const host = usePluginHost();
  const handle = host.documentHandle;
  const version = useRef(0);

  useSyncExternalStore(
    useCallback(
      (notify: () => void) =>
        handle.onChange(() => {
          version.current += 1;
          notify();
        }),
      [handle],
    ),
    () => version.current,
  );

  return handle;
}

/** A capability, re-read when one appears or disappears. Absence is normal. */
export function useCapability<K extends keyof Capabilities>(
  name: K,
): Capabilities[K] | undefined {
  const host = usePluginHost();
  useSyncExternalStore(
    host.capabilities.store.subscribe,
    () => host.capabilities.store.get(),
  );
  return host.capabilities.use(name);
}
