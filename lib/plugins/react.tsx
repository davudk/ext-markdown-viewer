/**
 * The React surface of the plugin host: regions, overlays, and the hooks a
 * plugin's components use to reach their own context.
 *
 * A contribution is declared on the plugin object, before any context exists,
 * so it cannot close over one. The host renders each contribution inside a
 * provider carrying that plugin's context, and `usePlugin()` reads it — which
 * keeps contributions plain components with no props to thread.
 */

import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { PluginHost } from './host.ts';
import type { PlacedContribution } from './registry.ts';
import type {
  DocumentHandle,
  PluginContext,
  RegionName,
  SettingsOf,
  SettingsSchema,
  Teardown,
} from './types.ts';

const HostContext = createContext<PluginHost | null>(null);
const PluginScope = createContext<PluginContext | null>(null);

export function PluginProvider({
  host,
  children,
}: {
  host: PluginHost;
  children: ReactNode;
}) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function usePluginHost(): PluginHost {
  const host = useContext(HostContext);
  if (!host) throw new Error('usePluginHost called outside a PluginProvider');
  return host;
}

/** The calling plugin's own context. Only valid inside a contribution. */
export function usePlugin<S extends SettingsSchema = SettingsSchema>(): PluginContext<S> {
  const ctx = useContext(PluginScope);
  if (!ctx) throw new Error('usePlugin called outside a plugin contribution');
  return ctx as PluginContext<S>;
}

/** This plugin's settings, re-rendering when they change. */
export function usePluginSettings<S extends SettingsSchema>(): SettingsOf<S> {
  const host = usePluginHost();
  const ctx = usePlugin<S>();
  useSyncExternalStore(host.status.subscribe, () => host.status.get());
  return ctx.settings;
}

export function useDocument(): DocumentHandle {
  const host = usePluginHost();
  useSyncExternalStore(host.status.subscribe, () => host.status.get());
  return host.documentHandle;
}

/* -------------------------------------------------------------------------- */
/* Error isolation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One broken contribution must not blank the document.
 *
 * React unmounts the whole tree on an uncaught render error, so without a
 * boundary per contribution a single plugin bug costs the reader the document
 * they came for — which is strictly worse than the extension not existing.
 */
class ContributionBoundary extends Component<
  { pluginId: string; onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/* -------------------------------------------------------------------------- */
/* Regions                                                                     */
/* -------------------------------------------------------------------------- */

function Contribution({ entry }: { entry: PlacedContribution }) {
  const host = usePluginHost();
  const ctx = host.contextOf(entry.pluginId);
  const ref = useRef<HTMLDivElement>(null);

  // The imperative escape hatch, for DOM code that is not React.
  const imperative = (entry as { imperative?: (host: HTMLElement) => Teardown | void })
    .imperative;

  useEffect(() => {
    if (!imperative || !ref.current) return;
    const teardown = imperative(ref.current);
    return () => teardown?.();
  }, [imperative]);

  if (!ctx) return null;
  if (imperative) return <div ref={ref} data-mdv-plugin={entry.pluginId} />;

  const Body = entry.component;
  return (
    <ContributionBoundary
      pluginId={entry.pluginId}
      onError={(error) =>
        host.reportRenderError(entry.pluginId, error)
      }
    >
      <PluginScope.Provider value={ctx}>
        <Body />
      </PluginScope.Provider>
    </ContributionBoundary>
  );
}

/**
 * A named mount point. Renders nothing when the region was never declared,
 * which is the normal state for a tab whose owning surface is disabled.
 */
export function Region({ name }: { name: RegionName }) {
  const host = usePluginHost();
  useSyncExternalStore(host.regions.store.subscribe, () => host.regions.store.get());

  const entries = host.regions.for(name);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry) => (
        <Contribution key={`${entry.pluginId}:${entry.key}`} entry={entry} />
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Overlays                                                                    */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Visible focusable descendants, in tab order.
 *
 * Filtered by `getClientRects()` rather than `offsetParent`, which lies about
 * position: fixed elements — and an overlay is exactly that.
 */
function collectFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * The overlay stack, rendered once for every plugin.
 *
 * Stacking is position in the stack rather than a number anyone picks, and the
 * focus trap, the `inert` beneath, and Escape all live here — previously five
 * components each implemented their own, and nested overlays were undefined.
 */
export function OverlayLayer() {
  const host = usePluginHost();
  const overlays = useSyncExternalStore(
    host.overlays.store.subscribe,
    () => host.overlays.store.get(),
  );

  const restoreTo = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (overlays.length === 0) return;

    // Captured on the way in, restored on the way out — a modal that returns
    // focus to the body has lost the reader's place.
    restoreTo.current ??= document.activeElement as HTMLElement | null;

    const root = document.getElementById('mdv-root');
    root?.setAttribute('inert', '');

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        // Only the top one: Escape in a stack closes the thing in front of you.
        const top = host.overlays.top();
        if (top) host.overlays.close(top.instanceId);
        return;
      }

      if (event.key !== 'Tab') return;

      // Containment, done once here rather than in every overlay. Scoped to the
      // topmost surface, so a stack traps in the thing the reader is looking at.
      const surface = layerRef.current?.lastElementChild as HTMLElement | undefined;
      const focusable = surface ? collectFocusable(surface) : [];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !surface?.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);

    // Focus the surface itself if the overlay brought nothing focusable —
    // otherwise Tab would escape to the inert document behind it.
    const surface = layerRef.current?.lastElementChild as HTMLElement | undefined;
    const target = surface ? (collectFocusable(surface)[0] ?? surface) : null;
    target?.focus();

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      if (host.overlays.store.get().length === 0) {
        root?.removeAttribute('inert');
        restoreTo.current?.isConnected && restoreTo.current.focus();
        restoreTo.current = null;
      }
    };
  }, [overlays.length, host]);

  if (overlays.length === 0) return null;

  return createPortal(
    <div className="mdv-overlays" ref={layerRef} data-mdv-chrome>
      {overlays.map((overlay, index) => {
        const ctx = host.contextOf(overlay.pluginId);
        if (!ctx) return null;
        const Body = overlay.component;
        const isTop = index === overlays.length - 1;

        return (
          <div
            key={overlay.instanceId}
            className="mdv-overlay"
            role="dialog"
            aria-modal={overlay.modal !== false}
            aria-label={overlay.label}
            // Only the top overlay is interactive; the rest are scenery.
            // React 19 types `inert` as a boolean, unlike the bare attribute.
            inert={!isTop}
            // -1 so the surface itself can hold focus when an overlay brings
            // nothing focusable of its own.
            tabIndex={-1}
            style={{ zIndex: 1000 + index }}
          >
            <ContributionBoundary
              pluginId={overlay.pluginId}
              onError={(error) => {
                host.reportRenderError(overlay.pluginId, error);
                host.overlays.close(overlay.instanceId);
              }}
            >
              <PluginScope.Provider value={ctx}>
                <Body close={() => host.overlays.close(overlay.instanceId)} />
              </PluginScope.Provider>
            </ContributionBoundary>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
