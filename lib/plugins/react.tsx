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
  Fragment,
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { PluginHost } from './host.ts';

import './overlays.css';
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

/**
 * Whatever a region's owner passes down to its contributions.
 *
 * The sidebar pilot needed to tell each tab "are you the visible one", "your
 * chord opened you, take focus", and "here are your aria ids" — and with no
 * route for it, outline/files/search ended up importing a React context out of
 * the sidebar plugin. A plugin importing another plugin is the one thing the
 * API forbids, so the route exists now.
 */
const RegionScope = createContext<unknown>(undefined);

/** The value the surrounding region's owner passed down. */
export function useRegionScope<T>(): T | undefined {
  return useContext(RegionScope) as T | undefined;
}

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

/**
 * The shared document, re-rendering whenever it changes.
 *
 * Subscribes to the document's own version rather than the host's status store,
 * which only tracks enable/disable — the presentation pilot found that a
 * contribution reading `isRaw` never re-rendered on a raw toggle.
 */
export function useDocument(): DocumentHandle {
  const host = usePluginHost();
  const handle = host.documentHandle as DocumentHandle & {
    version?: { subscribe: (fn: () => void) => () => void; get: () => number };
  };

  useSyncExternalStore(
    handle.version?.subscribe ?? noopSubscribe,
    () => handle.version?.get() ?? 0,
  );

  return handle;
}

const noopSubscribe = () => () => {};

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
  if (imperative) {
    // `display: contents` because the wrapper is plumbing, not layout: the
    // shell's `.mdv > :not(nav)` grants every non-nav child `flex: 1 1 auto`,
    // so a plain div here became a second document column. Found by a plugin
    // trying to mount an aria-live region.
    return (
      <div
        ref={ref}
        data-mdv-plugin={entry.pluginId}
        style={{ display: 'contents' }}
      />
    );
  }

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
 *
 * `scope` is handed to every contribution; `wrap` lets the owner put each one
 * in its own container — a `role="tabpanel"` with the right aria ids, say —
 * which the flat list could not express.
 */
export function Region<T>({
  name,
  scope,
  wrap,
}: {
  name: RegionName;
  scope?: T;
  wrap?: (entry: PlacedContribution, body: ReactNode) => ReactNode;
}) {
  const host = usePluginHost();
  useSyncExternalStore(host.regions.store.subscribe, () => host.regions.store.get());

  const entries = host.regions.for(name);
  if (entries.length === 0) return null;

  return (
    <RegionScope.Provider value={scope}>
      {entries.map((entry) => {
        const key = `${entry.pluginId}:${entry.key}`;
        const body = <Contribution entry={entry} />;
        return (
          <Fragment key={key}>{wrap ? wrap(entry, body) : body}</Fragment>
        );
      })}
    </RegionScope.Provider>
  );
}

/**
 * What a region currently holds, without rendering it.
 *
 * For an owner that must decide layout — `.mdv-with-toc` lives on the shell,
 * a level above anything a contribution can reach, so the sidebar was climbing
 * the DOM with `closest()` to set it. Also the route to a contribution's `meta`,
 * which a tab strip needs before its panel renders.
 */
export function useRegionContents(name: RegionName): readonly PlacedContribution[] {
  const host = usePluginHost();
  useSyncExternalStore(host.regions.store.subscribe, () => host.regions.store.get());
  return host.regions.for(name);
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

  // `modal` was accepted and ignored, so the first non-modal overlay — quick
  // find — inerted the document behind it and made the page unclickable and
  // unselectable while the find bar was open. Modality is a property of the
  // stack, not of the topmost surface: one modal anywhere holds the document.
  const hasModal = overlays.some((overlay) => overlay.modal !== false);

  useEffect(() => {
    if (overlays.length === 0 || !hasModal) return;

    // Captured on the way in, restored on the way out — a modal that returns
    // focus to the body has lost the reader's place.
    restoreTo.current ??= document.activeElement as HTMLElement | null;

    const root = document.getElementById('mdv-root');
    root?.setAttribute('inert', '');

    // Scroll lock. `inert` stops interaction but not wheel events, so without
    // this a flick anywhere outside an opaque overlay scrolls the document
    // invisibly and loses the reader's place. Both the presentation and
    // lightbox migrations reported having to keep their own copy; two
    // independent reports is the threshold for it belonging here.
    //
    // The scrollbar's width is paid back as padding, or removing it reflows the
    // document behind the overlay — visible the moment the overlay closes.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.documentElement.style.overflow;
    const previousPadding = document.documentElement.style.paddingRight;
    document.documentElement.style.overflow = 'hidden';
    if (scrollbar > 0) document.documentElement.style.paddingRight = `${scrollbar}px`;

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
      if (!host.overlays.store.get().some((o) => o.modal !== false)) {
        document.documentElement.style.overflow = previousOverflow;
        document.documentElement.style.paddingRight = previousPadding;
        root?.removeAttribute('inert');
        restoreTo.current?.isConnected && restoreTo.current.focus();
        restoreTo.current = null;
      }
    };
  }, [overlays.length, hasModal, host]);

  useEffect(() => {
    if (overlays.length === 0) return;

    // Registered whether or not anything is modal: Escape closes the topmost
    // overlay either way, and the effect above only runs for modal stacks.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const top = host.overlays.top();
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      host.overlays.close(top.instanceId);
    };

    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
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
            data-mdv-modal={overlay.modal !== false ? '' : undefined}
            inert={!isTop && overlay.modal !== false}
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
