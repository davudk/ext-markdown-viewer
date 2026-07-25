import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import {
  DEFAULT_SIDEBAR_TAB,
  SIDEBAR_TABS,
  type SidebarTabId,
} from '@/lib/config';
import { isFolderBrowserSupported } from '@/lib/folder';
import type { Heading } from '@/lib/markdown';
import { loadSidebarTab, saveSidebarTab } from '@/lib/settings';

import { FolderBrowser, type FolderStatus, type OpenedDocument } from './FolderBrowser';
import { Toc } from './Toc';

import './sidebar.css';

/** Viewport width below which the sidebar starts collapsed rather than eating the measure. */
const AUTO_COLLAPSE_PX = 900;

export interface SidebarProps {
  headings: Heading[];
  /**
   * The document on screen: `location.href` normally, or the `mdv-folder:`
   * identity of a file opened through the Files tab. Used to mark the current
   * file in the tree, never to fetch anything.
   */
  documentUrl: string;
  /** The markdown currently rendered. See `FolderBrowser` for what it is for. */
  source: string;
  /** A file was opened through a handle and the shell should render it instead. */
  onOpenDocument: (document: OpenedDocument) => void;
}

/** What the tab strip needs to know to say whether a tab is worth opening. */
interface PanelContext {
  headings: Heading[];
  folder: FolderStatus;
  /** How the Files panel reports back what it found. */
  setFolder: (status: FolderStatus) => void;
}

interface PanelDefinition {
  render: (props: SidebarProps, visible: boolean, context: PanelContext) => ReactNode;
  /** One line explaining why this tab has nothing in it, or null when it does. */
  hint: (context: PanelContext) => string | null;
  /** True when the tab cannot work in this browser at all, so never restore onto it. */
  blocked?: (context: PanelContext) => boolean;
}

/**
 * Every tab, keyed by the ids `SIDEBAR_TABS` declares.
 *
 * A third tab — Search — is planned, and this is the shape that makes it an
 * entry rather than a rewrite: one line in `SIDEBAR_TABS` for the label and one
 * here for the contents. Nothing below this object knows how many tabs exist.
 */
const PANELS: Record<SidebarTabId, PanelDefinition> = {
  outline: {
    render: (props, visible) => <Toc headings={props.headings} visible={visible} />,
    hint: ({ headings }) =>
      headings.length === 0 ? 'This document has no headings.' : null,
  },
  files: {
    render: (props, visible, context) => (
      <FolderBrowser
        documentUrl={props.documentUrl}
        source={props.source}
        visible={visible}
        onOpen={props.onOpenDocument}
        onStatusChange={context.setFolder}
      />
    ),
    hint: ({ folder }) => {
      if (folder === 'unsupported') return 'This browser cannot open local folders.';
      if (folder === 'idle') return 'No folder is open.';
      return null;
    },
    blocked: ({ folder }) => folder === 'unsupported',
  },
};

/**
 * The sidebar: one `<nav>`, a collapse toggle, a tab strip, and the panels.
 *
 * The single `<nav>` is load-bearing. `entrypoints/viewer.css` gives the
 * sidebar its own flex track through `.mdv-with-toc > nav`, so exactly one nav
 * may be a direct child of `.mdv` — which is why the tabs live inside this
 * element rather than each panel bringing its own landmark.
 *
 * Both panels stay mounted while the other is showing, hidden rather than
 * unmounted. That is not a micro-optimisation: the outline's scroll-spy has to
 * keep tracking so switching back shows where the reader is *now*, and the
 * folder tree has to keep its opened directories and its permission grant, both
 * of which cost a click to rebuild.
 */
export function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = useState(startsExpanded);
  const [tab, setTab] = useState<SidebarTabId>(DEFAULT_SIDEBAR_TAB);
  const [folder, setFolder] = useState<FolderStatus>(() =>
    isFolderBrowserSupported() ? 'idle' : 'unsupported',
  );

  const baseId = useId();
  const bodyId = `${baseId}-body`;
  const tabId = (id: SidebarTabId) => `${baseId}-tab-${id}`;
  const panelId = (id: SidebarTabId) => `${baseId}-panel-${id}`;

  const buttonsRef = useRef(new Map<SidebarTabId, HTMLButtonElement>());

  const context: PanelContext = { headings: props.headings, folder, setFolder };

  const select = useCallback((next: SidebarTabId) => {
    setTab(next);
    void saveSidebarTab(next);
  }, []);

  // Restore where the reader left the sidebar. Not through the settings object:
  // this is UI state, and it arrives a tick after the first paint on purpose —
  // guessing synchronously would mean flashing the wrong tab.
  useEffect(() => {
    let alive = true;
    void loadSidebarTab().then((stored) => {
      if (!alive) return;
      // A remembered tab that cannot work in this browser is not worth landing
      // on; one that is merely empty still is, because that is where the button
      // to fill it lives.
      const blocked = PANELS[stored].blocked?.({ headings: props.headings, folder, setFolder });
      setTab(blocked ? DEFAULT_SIDEBAR_TAB : stored);
    });
    return () => {
      alive = false;
    };
    // Once, on mount: this restores a stored value, it does not track state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Arrow keys move between tabs and select as they go.
   *
   * Automatic activation is the right call precisely because both panels are
   * always mounted — arrowing across the strip costs a `hidden` attribute, so
   * there is nothing to defer and no reason to make the reader press Enter.
   */
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const order = SIDEBAR_TABS.map((entry) => entry.id);
    const at = order.indexOf(tab);

    const to = (index: number) => {
      event.preventDefault();
      const next = order[(index + order.length) % order.length];
      select(next);
      buttonsRef.current.get(next)?.focus();
    };

    if (event.key === 'ArrowRight') to(at + 1);
    else if (event.key === 'ArrowLeft') to(at - 1);
    else if (event.key === 'Home') to(0);
    else if (event.key === 'End') to(order.length - 1);
  };

  return (
    <nav
      className={expanded ? 'mdv-toc' : 'mdv-toc mdv-toc-is-collapsed'}
      aria-label="Document sidebar"
      data-mdv-chrome
    >
      <div className="mdv-toc-head">
        <button
          type="button"
          className="mdv-toc-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? 'Hide sidebar' : 'Show sidebar'}
          title={expanded ? 'Hide sidebar' : 'Show sidebar'}
          onClick={() => setExpanded((open) => !open)}
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
          {SIDEBAR_TABS.map(({ id, label }) => {
            const hint = PANELS[id].hint(context);
            return (
              <button
                key={id}
                type="button"
                id={tabId(id)}
                className="mdv-side-tab"
                role="tab"
                aria-selected={id === tab}
                aria-controls={panelId(id)}
                // Roving: only the selected tab is a tab stop, so Tab enters the
                // strip once and the arrows do the rest.
                tabIndex={id === tab ? 0 : -1}
                // Not `disabled`. A tab that explains why it is empty has to be
                // reachable to explain it, and for Files the panel behind it is
                // where the button that fills it lives.
                aria-disabled={hint === null ? undefined : true}
                data-mdv-quiet={hint === null ? undefined : ''}
                title={hint ?? undefined}
                ref={(node) => {
                  if (node) buttonsRef.current.set(id, node);
                  return () => {
                    buttonsRef.current.delete(id);
                  };
                }}
                onClick={() => select(id)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mdv-side-body" id={bodyId} hidden={!expanded}>
        {SIDEBAR_TABS.map(({ id }) => (
          <div
            key={id}
            id={panelId(id)}
            className="mdv-side-panel"
            role="tabpanel"
            aria-labelledby={tabId(id)}
            hidden={id !== tab}
          >
            {PANELS[id].render(props, expanded && id === tab, context)}
          </div>
        ))}
      </div>
    </nav>
  );
}

/** Narrow windows open collapsed; the reader can still pull the sidebar out. */
function startsExpanded(): boolean {
  return !matchMedia(`(max-width: ${AUTO_COLLAPSE_PX}px)`).matches;
}

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
