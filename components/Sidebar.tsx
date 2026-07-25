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
  SEARCH_ALL_KEY,
  SIDEBAR_TABS,
  type SidebarTabId,
} from '@/lib/config';
import { isFolderBrowserSupported } from '@/lib/folder';
import type { Heading } from '@/lib/markdown';
import { loadSidebarTab, saveSidebarTab } from '@/lib/settings';

import type { CompareRequest } from '@/lib/diff';

import { FolderBrowser, type FolderStatus, type OpenedDocument } from './FolderBrowser';
import { SearchPanel } from './SearchPanel';
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
  /**
   * Compare a file in the tree with the one on screen. Optional on purpose:
   * without it `FolderBrowser` leaves the browser's own context menu alone
   * rather than claiming right-click for a menu whose action goes nowhere.
   */
  onCompare?: (request: CompareRequest) => void;
}

/** What the tab strip needs to know to say whether a tab is worth opening. */
interface PanelContext {
  headings: Heading[];
  folder: FolderStatus;
  /** How the Files panel reports back what it found. */
  setFolder: (status: FolderStatus) => void;
  /**
   * Bumped when a tab was opened by its own shortcut, which is the only moment
   * a panel may take focus. Clicking a tab, or arrowing across the strip, must
   * leave focus on the button the reader is standing on.
   */
  focusToken: number;
  /** Back to whichever tab was showing before a shortcut took over. */
  dismiss: () => void;
}

interface PanelDefinition {
  render: (props: SidebarProps, visible: boolean, context: PanelContext) => ReactNode;
  /** One line explaining why this tab has nothing in it, or null when it does. */
  hint: (context: PanelContext) => string | null;
  /** True when the tab cannot work in this browser at all, so never restore onto it. */
  blocked?: (context: PanelContext) => boolean;
  /**
   * A chord that opens this tab from anywhere in the document.
   *
   * Declared per panel rather than in one switch below, so the key a tab answers
   * to is written next to the tab — and so `dismiss` and `focusToken` are wired
   * once for every tab that ever wants them rather than once per tab.
   */
  shortcut?: (event: KeyboardEvent) => boolean;
}

/**
 * Every tab, keyed by the ids `SIDEBAR_TABS` declares.
 *
 * The claim this object was built to make: adding a tab is one line in
 * `SIDEBAR_TABS` for the label and one entry here for the contents. Search was
 * the test of it, and it held — the shortcut, the previous-tab restore and the
 * focus handshake are all declared here too, but they are optional fields the
 * next tab inherits for free rather than special cases in the shell.
 *
 * Nothing below this object knows how many tabs exist.
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
        onCompare={props.onCompare}
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
  search: {
    render: (props, visible, context) => (
      <SearchPanel
        source={props.source}
        headings={props.headings}
        visible={visible}
        folderStatus={context.folder}
        focusToken={context.focusToken}
        onClose={context.dismiss}
        onOpenDocument={props.onOpenDocument}
      />
    ),
    // Never empty: with no document and no folder it is still a field waiting
    // for a query, which is the whole tab.
    hint: () => null,
    // Shift is what separates this from quick find, which owns the unshifted
    // chord and is a different feature rather than a smaller version of this one.
    shortcut: (event) =>
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === SEARCH_ALL_KEY,
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
 * Every panel stays mounted while another is showing, hidden rather than
 * unmounted. That is not a micro-optimisation: the outline's scroll-spy has to
 * keep tracking so switching back shows where the reader is *now*, the folder
 * tree has to keep its opened directories and its permission grant, and Search
 * has to keep the query and the results that go with it — all of which cost a
 * click, or a folder-wide sweep, to rebuild.
 *
 * The sidebar is also where a tab's keyboard shortcut is honoured, which means
 * ctrl/cmd+shift+F only reaches Search while the sidebar exists. With "show
 * sidebar" off there is nothing to open, and quick find — which is a fixed
 * overlay and not part of this tree — is what remains.
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

  /** The tab a shortcut interrupted, and where focus was when it did. */
  const previousRef = useRef<SidebarTabId | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  /** `tab`, readable from the window listener, which is bound once. */
  const tabRef = useRef(tab);
  useEffect(() => {
    tabRef.current = tab;
  });

  const [focusToken, setFocusToken] = useState(0);

  const select = useCallback((next: SidebarTabId) => {
    setTab(next);
    void saveSidebarTab(next);
  }, []);

  /**
   * Undo whatever a shortcut did: the tab that was showing comes back, and focus
   * goes where it was. Both are needed — restoring the tab and leaving focus in
   * a panel that is now hidden strands the reader's cursor off screen.
   *
   * Falls back to closing nothing when the tab was reached by clicking, because
   * there is then no "before" to return to and Escape should not move anything.
   */
  const dismiss = useCallback(() => {
    const back = previousRef.current;
    previousRef.current = null;
    if (back) select(back);

    const restore = restoreRef.current;
    restoreRef.current = null;
    if (restore?.isConnected) restore.focus();
  }, [select]);

  const context: PanelContext = {
    headings: props.headings,
    folder,
    setFolder,
    focusToken,
    dismiss,
  };

  /**
   * Picking a tab by hand, as opposed to a shortcut opening one.
   *
   * The difference is the whole reason both exist: a shortcut is an interruption
   * and has somewhere to go back to, a click is a decision and does not. Clearing
   * the two refs here is what stops Escape, pressed ten minutes later, from
   * yanking the sidebar back to a tab the reader deliberately left.
   */
  const choose = useCallback(
    (next: SidebarTabId) => {
      previousRef.current = null;
      restoreRef.current = null;
      select(next);
    },
    [select],
  );

  // One listener for every tab that declares a chord. Bound once and reading the
  // current tab from a ref, so adding a shortcut is an entry in PANELS and
  // nothing here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;

      for (const { id } of SIDEBAR_TABS) {
        if (!PANELS[id].shortcut?.(event)) continue;

        event.preventDefault();
        if (tabRef.current !== id) {
          previousRef.current = tabRef.current;
          const active = document.activeElement;
          restoreRef.current = active instanceof HTMLElement ? active : null;
          select(id);
        }

        // The sidebar may be collapsed to its rail, in which case the panel is
        // rendered but `hidden`, and focusing into it would be focusing nothing.
        setExpanded(true);
        setFocusToken((count) => count + 1);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [select]);

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
      const blocked = PANELS[stored].blocked?.({ ...context, headings: props.headings });
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
      choose(next);
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
                onClick={() => choose(id)}
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
