import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { Region, usePluginHost } from '../../lib/plugins/react.tsx';

import { SidebarScope, useCapability, useLiveDocument } from './context.tsx';
import type { SidebarSnapshot } from './state.ts';
import { loadSidebarTab } from './storage.ts';
import { SIDEBAR_TAB_REGION, type PlacedSidebarTab } from './tabs.ts';

import './sidebar.css';

/**
 * The sidebar: one `<nav>`, a collapse toggle, a tab strip, and the panels.
 *
 * The single `<nav>` is load-bearing. `entrypoints/viewer.css` gives the
 * sidebar its own flex track through `.mdv-with-toc > nav`, so exactly one nav
 * may be a direct child of `.mdv` — which is why the tabs live inside this
 * element rather than each panel bringing its own landmark. A contribution
 * renders with no wrapper of its own, so this component must render exactly one
 * element: `.mdv > :not(nav)` would otherwise hand a second one a
 * document-sized flex track.
 *
 * Nothing here knows how many tabs exist, or what any of them contain. The
 * strip is read out of the `sidebar.tab` region: labels come off the
 * contributions, order comes from `order`, and each panel draws itself. The
 * hand-rolled `SIDEBAR_TABS`/`PANELS` pair this replaces made the same claim,
 * but it made it about a table two files away rather than about plugins.
 */
export function SidebarNav() {
  const host = usePluginHost();
  const state = useCapability('sidebar');
  const rendered = useLiveDocument();

  // The strip has to re-render when a tab plugin is enabled or disabled, which
  // is a change to the region registry rather than to anything here.
  useSyncExternalStore(host.regions.store.subscribe, () => host.regions.store.get());
  const tabs = host.regions.for(SIDEBAR_TAB_REGION) as readonly PlacedSidebarTab[];

  const snapshot = useSyncExternalStore(
    state?.store.subscribe ?? NO_SUBSCRIBE,
    () => state?.store.get() ?? EMPTY,
  );

  const baseId = useId();
  const bodyId = `${baseId}-body`;
  const ids = useMemo(
    () => ({
      tab: (key: string) => `${baseId}-tab-${key}`,
      panel: (key: string) => `${baseId}-panel-${key}`,
    }),
    [baseId],
  );

  const buttonsRef = useRef(new Map<string, HTMLButtonElement>());
  const navRef = useRef<HTMLElement>(null);

  const keys = tabs.map((tab) => tab.key);
  const selected = snapshot.selected ?? keys[0] ?? null;
  const { expanded } = snapshot;

  const scope = useMemo(
    () => ({ state: state ?? null, snapshot: { ...snapshot, selected }, ids }),
    [state, snapshot, selected, ids],
  );

  // The raw view has no outline to index and no column to spare, so the sidebar
  // is not part of that page at all. Conditional rendering is the
  // contribution's own business, which is why there is no `when` on the API.
  const hidden = rendered.isRaw || state === undefined;

  /**
   * The shell's layout mode, set from here because only this component knows
   * whether the column exists.
   *
   * `.mdv-with-toc > nav` is the sidebar's flex track, and `.mdv-with-toc` sits
   * on the shell — one level above anything a contribution can render. Nothing
   * in the region model lets a contribution tell its container that it has
   * content, so the class goes on the ancestor by hand and comes off the moment
   * this unmounts, which is what gives the document its full width back when
   * the plugin is disabled or the raw view is opened.
   */
  useEffect(() => {
    const shell = navRef.current?.closest('.mdv');
    if (!shell) return;

    shell.classList.add('mdv-with-toc');
    return () => shell.classList.remove('mdv-with-toc');
  }, [hidden]);

  // Restore where the reader left the sidebar. It arrives a tick after the
  // first paint on purpose — guessing synchronously would mean flashing the
  // wrong tab — and is validated against the tabs that exist now, so a
  // remembered tab whose plugin has since been disabled lands on the first one.
  const restored = useRef(false);
  useEffect(() => {
    if (!state || restored.current || keys.length === 0) return;
    restored.current = true;
    void loadSidebarTab().then((stored) => state.restore(stored, keys));
    // Once, as soon as there is a tab to land on: this restores a stored value,
    // it does not track state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, keys.length]);

  const choose = useCallback((next: string) => state?.select(next), [state]);

  /**
   * Arrow keys move between tabs and select as they go.
   *
   * Automatic activation is the right call precisely because every panel is
   * always mounted — arrowing across the strip costs a `hidden` attribute, so
   * there is nothing to defer and no reason to make the reader press Enter.
   */
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (keys.length === 0) return;
    const at = keys.indexOf(selected ?? '');

    const to = (index: number) => {
      event.preventDefault();
      const next = keys[(index + keys.length) % keys.length];
      choose(next);
      buttonsRef.current.get(next)?.focus();
    };

    if (event.key === 'ArrowRight') to(at + 1);
    else if (event.key === 'ArrowLeft') to(at - 1);
    else if (event.key === 'Home') to(0);
    else if (event.key === 'End') to(keys.length - 1);
  };

  if (hidden) return null;

  return (
    <nav
      className={expanded ? 'mdv-toc' : 'mdv-toc mdv-toc-is-collapsed'}
      aria-label="Document sidebar"
      data-mdv-chrome
      ref={navRef}
    >
      <div className="mdv-toc-head">
        <button
          type="button"
          className="mdv-toc-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? 'Hide sidebar' : 'Show sidebar'}
          title={expanded ? 'Hide sidebar' : 'Show sidebar'}
          onClick={() => state?.setExpanded(!expanded)}
        >
          {expanded ? <ChevronIcon /> : <ListIcon />}
        </button>

        <div
          className="mdv-side-tabs"
          role="tablist"
          aria-label="Sidebar sections"
          aria-orientation="horizontal"
          hidden={!expanded}
          onKeyDown={onTabKeyDown}
        >
          {tabs.map(({ key, label }) => {
            // Reported by the panel itself: it is the only thing that knows
            // whether it has anything in it, and it stays mounted while hidden
            // precisely so it can keep saying so.
            const hint = snapshot.hints[key] ?? null;

            return (
              <button
                key={key}
                type="button"
                id={ids.tab(key)}
                className="mdv-side-tab"
                role="tab"
                aria-selected={key === selected}
                aria-controls={ids.panel(key)}
                // Roving: only the selected tab is a tab stop, so Tab enters the
                // strip once and the arrows do the rest.
                tabIndex={key === selected ? 0 : -1}
                // Not `disabled`. A tab that explains why it is empty has to be
                // reachable to explain it, and for Files the panel behind it is
                // where the button that fills it lives.
                aria-disabled={hint === null ? undefined : true}
                data-mdv-quiet={hint === null ? undefined : ''}
                title={hint ?? undefined}
                ref={(node) => {
                  if (node) buttonsRef.current.set(key, node);
                  return () => {
                    buttonsRef.current.delete(key);
                  };
                }}
                onClick={() => choose(key)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mdv-side-body" id={bodyId} hidden={!expanded}>
        <SidebarScope.Provider value={scope}>
          <Region name={SIDEBAR_TAB_REGION} />
        </SidebarScope.Provider>
      </div>
    </nav>
  );
}

/** Only reachable if `setup` failed, in which case there is nothing to render. */
const EMPTY: SidebarSnapshot = {
  expanded: true,
  selected: null,
  focusToken: 0,
  focusedKey: null,
  hints: {},
  blocked: [],
};

const NO_SUBSCRIBE = () => () => {};

/* -------------------------------------------------------------------------- */
/* Icons — inline, because the extension never loads a resource of any kind.   */
/* -------------------------------------------------------------------------- */

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M10 3.25 5.25 8 10 12.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4h11M2.5 8h11M2.5 12h7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
