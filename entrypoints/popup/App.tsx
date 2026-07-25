import { useCallback, useEffect, useState } from 'react';

import {
  RESTRICTED_SCHEMES,
  VIEWER_ROOT_ID,
} from '@/lib/config';
import { isCandidateUrl, originPattern } from '@/lib/detect';
import {
  sendMessage,
  type RenderTabResult,
  type SyncResult,
} from '@/lib/messages';
import {
  hasFileAccess,
  isAutoRenderEnabled,
  revokeOrigin,
} from '@/lib/permissions';
import {
  DEFAULT_SETTINGS,
  THEME_OPTIONS,
  loadSettings,
  saveSettings,
  type Theme,
} from '@/lib/settings';
import './App.css';

/**
 * What the popup is looking at. Everything the UI branches on is decided once,
 * up front, so the render path itself has no async holes to flash through.
 */
type Target =
  /** Still resolving the active tab; the UI shows a skeleton. */
  | { kind: 'loading' }
  /** No active tab, or its URL is unreadable. */
  | { kind: 'unknown' }
  /** A browser-internal page, where no extension may run. */
  | { kind: 'restricted' }
  /** A perfectly normal page that just isn't a markdown file. */
  | { kind: 'plain'; label: string }
  /** A markdown file over http(s) — both permission tiers apply. */
  | { kind: 'web'; tabId: number; host: string; pattern: string }
  /** A markdown file on disk — governed by the browser-level file toggle. */
  | { kind: 'file'; tabId: number; name: string };

/**
 * Whether the tab in front of us has already been taken over by the renderer.
 * `unknown` is a real answer and is treated as one: the popup under-claims
 * rather than announcing a success it can't see.
 */
type RenderState = 'rendered' | 'raw' | 'unknown';

type Notice = { tone: 'ok' | 'error'; text: string };

type Busy = 'render' | 'grant' | 'revoke' | null;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '').trim();
  return text || 'Something went wrong.';
}

/** Last path segment of a file:// URL, for naming the document the user opened. */
function fileName(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  try {
    return decodeURIComponent(last) || 'this file';
  } catch {
    return last || 'this file';
  }
}

/** A short, human-readable stand-in for a URL we aren't going to act on. */
function pageLabel(url: URL): string {
  return url.protocol === 'file:' ? fileName(url) : url.hostname;
}

/**
 * Ask the tab itself whether the renderer already claimed it. This is what
 * keeps the automatic-rendering copy honest: the permission can be granted
 * while a tab opened before the grant still shows raw text, and the popup has
 * no business claiming otherwise.
 *
 * `executeScript` here rides on activeTab, which opening the popup grants.
 * A still-loading tab is reported as `unknown` rather than `raw`, because the
 * renderer mounts on DOMContentLoaded and racing it would produce a confident
 * wrong answer.
 */
async function detectRenderState(
  tabId: number,
  status: string | undefined,
): Promise<RenderState> {
  if (status !== 'complete') return 'unknown';

  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      // Serialized and run in the page, so it may not close over anything —
      // the id has to travel as an argument to stay a single source of truth.
      func: (rootId: string) => document.getElementById(rootId) !== null,
      args: [VIEWER_ROOT_ID],
    });
    if (typeof frame?.result !== 'boolean') return 'unknown';
    return frame.result ? 'rendered' : 'raw';
  } catch {
    return 'unknown';
  }
}

interface Resolved {
  target: Target;
  /** This one site renders automatically. Only meaningful when `!autoRender`. */
  granted: boolean;
  fileAccess: boolean;
  /** The all-sites grant: "render markdown automatically on every site". */
  autoRender: boolean;
  renderState: RenderState;
}

async function resolveTarget(): Promise<Resolved> {
  const idle = {
    granted: false,
    fileAccess: false,
    autoRender: false,
    renderState: 'unknown' as const,
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) return { target: { kind: 'unknown' }, ...idle };

  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return { target: { kind: 'unknown' }, ...idle };
  }

  if (RESTRICTED_SCHEMES.includes(url.protocol)) {
    return { target: { kind: 'restricted' }, ...idle };
  }

  if (!isCandidateUrl(tab.url)) {
    return { target: { kind: 'plain', label: pageLabel(url) }, ...idle };
  }

  if (url.protocol === 'file:') {
    // The all-sites grant is `*://*/*`, which does not cover file://; local
    // files are governed by the browser toggle alone, so it isn't consulted.
    const fileAccess = await hasFileAccess();
    return {
      ...idle,
      target: { kind: 'file', tabId: tab.id, name: fileName(url) },
      fileAccess,
    };
  }

  const pattern = originPattern(tab.url);
  if (!pattern) {
    return { target: { kind: 'plain', label: pageLabel(url) }, ...idle };
  }

  // Read fresh on every open: the options page is one tab away and can change
  // this out from under us, so nothing here is cached between popup sessions.
  const autoRender = await isAutoRenderEnabled();

  let granted = autoRender;
  if (!autoRender) {
    try {
      granted = await chrome.permissions.contains({ origins: [pattern] });
    } catch {
      // Treat an unreadable permission state as "not granted": the worst case
      // is offering a grant the user already has, which Chrome resolves
      // instantly.
      granted = false;
    }
  }

  return {
    target: { kind: 'web', tabId: tab.id, host: url.hostname, pattern },
    granted,
    fileAccess: false,
    autoRender,
    renderState: autoRender
      ? await detectRenderState(tab.id, tab.status)
      : 'unknown',
  };
}

function CheckIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2 5h7.3M13.2 5H14M2 11h1.5M7.5 11H14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle
        cx="11.25"
        cy="5"
        r="1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle
        cx="5.5"
        cy="11"
        r="1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

function MarkIcon() {
  return (
    <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
      <rect
        x="1.75"
        y="4.25"
        width="16.5"
        height="11.5"
        rx="2.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M5 12.75V7.25l2.5 3 2.5-3v5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 7.25v5.5m0 0l-1.6-1.9M13 12.75l1.6-1.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ThemePicker({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (next: Theme) => void;
}) {
  // A radiogroup rather than a fieldset: `display: flex` on a fieldset is laid
  // out inconsistently, and the group here needs to sit on one 320px row.
  return (
    <div className="themes" role="radiogroup" aria-label="Theme">
      <span className="themes-label" aria-hidden="true">
        Theme
      </span>
      <div className="segmented">
        {THEME_OPTIONS.map(({ value, label }) => (
          <label
            key={value}
            className={value === theme ? 'segment is-on' : 'segment'}
          >
            <input
              type="radio"
              name="theme"
              value={value}
              checked={value === theme}
              onChange={() => onChange(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [target, setTarget] = useState<Target>({ kind: 'loading' });
  const [granted, setGranted] = useState(false);
  const [fileAccess, setFileAccess] = useState(false);
  const [autoRender, setAutoRender] = useState(false);
  const [renderState, setRenderState] = useState<RenderState>('unknown');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [theme, setTheme] = useState<Theme>(DEFAULT_SETTINGS.theme);

  const detect = useCallback(async () => {
    try {
      const next = await resolveTarget();
      setTarget(next.target);
      setGranted(next.granted);
      setFileAccess(next.fileAccess);
      setAutoRender(next.autoRender);
      setRenderState(next.renderState);

      // The file toggle lives outside the extension, so a sync here is what
      // picks it up after the user flips it and comes back.
      if (next.target.kind === 'file' && next.fileAccess) {
        void sendMessage<SyncResult>({ type: 'SYNC_REGISTRATIONS' }).catch(
          () => undefined,
        );
      }
    } catch {
      setTarget({ kind: 'unknown' });
    }
  }, []);

  useEffect(() => {
    void detect();
    void loadSettings().then((settings) => setTheme(settings.theme));
  }, [detect]);

  // Match the popup to the documents it renders. `auto` defers to the OS via
  // prefers-color-scheme; an explicit choice overrides it in both directions.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const chooseTheme = (next: Theme) => {
    setTheme(next);
    // Open documents restyle themselves off the storage change; nothing else
    // to do here, and a failed write shouldn't break the rest of the popup.
    void saveSettings({ theme: next }).catch(() => undefined);
  };

  /**
   * The options page owns everything the popup deliberately doesn't repeat:
   * the automatic-rendering switch, the list of granted sites, and the full
   * file:// instructions.
   */
  const openSettings = useCallback(() => {
    setNotice(null);
    try {
      const opening = chrome.runtime.openOptionsPage?.();
      // Chrome resolves this even when it can't open the page in older
      // versions, so failures surface through the rejection path only.
      void opening?.catch?.(() =>
        setNotice({ tone: 'error', text: "Couldn't open settings." }),
      );
    } catch {
      setNotice({ tone: 'error', text: "Couldn't open settings." });
    }
  }, []);

  /** Tier 1: inject via the activeTab grant. Never shows a permission prompt. */
  const render = useCallback(
    async (tabId: number, quiet = false): Promise<boolean> => {
      try {
        const result = await sendMessage<RenderTabResult>({
          type: 'RENDER_TAB',
          tabId,
        });
        if (result?.ok) {
          setRenderState('rendered');
          setNotice({ tone: 'ok', text: 'Rendered this page.' });
          return true;
        }
        if (!quiet) {
          setNotice({
            tone: 'error',
            text: result?.error ?? "Couldn't render this page.",
          });
        }
        return false;
      } catch (error) {
        if (!quiet) setNotice({ tone: 'error', text: describeError(error) });
        return false;
      }
    },
    [],
  );

  const handleRender = async (tabId: number) => {
    setNotice(null);
    setBusy('render');
    await render(tabId);
    setBusy(null);
  };

  /**
   * Tier 2. `permissions.request()` must be the first thing the click handler
   * does: awaiting anything before it spends the user gesture and Chrome
   * rejects the call.
   */
  const handleGrant = (pattern: string, host: string, tabId: number) => {
    setNotice(null);
    setBusy('grant');

    chrome.permissions
      .request({ origins: [pattern] })
      .then(async (ok) => {
        if (!ok) {
          setNotice({ tone: 'ok', text: `Left ${host} as it was.` });
          return;
        }
        setGranted(true);
        await sendMessage<SyncResult>({ type: 'SYNC_REGISTRATIONS' }).catch(
          () => undefined,
        );
        // This page loaded before the script was registered, so render it now
        // rather than making the user reload to see the thing they asked for.
        await render(tabId, true);
        setNotice({
          tone: 'ok',
          text: `Markdown files on ${host} now render automatically.`,
        });
      })
      .catch((error) => setNotice({ tone: 'error', text: describeError(error) }))
      .finally(() => setBusy(null));
  };

  const handleRevoke = (pattern: string, host: string) => {
    setNotice(null);
    setBusy('revoke');

    revokeOrigin(pattern)
      .then(async (removed) => {
        if (!removed) {
          setNotice({ tone: 'error', text: `Couldn't remove access to ${host}.` });
          return;
        }
        setGranted(false);
        await sendMessage<SyncResult>({ type: 'SYNC_REGISTRATIONS' }).catch(
          () => undefined,
        );
        setNotice({ tone: 'ok', text: `Removed access to ${host}.` });
      })
      .catch((error) => setNotice({ tone: 'error', text: describeError(error) }))
      .finally(() => setBusy(null));
  };

  return (
    <div className="popup">
      <header className="head">
        <MarkIcon />
        <h1>Markdown Viewer</h1>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={openSettings}
          title="Settings"
          aria-label="Settings"
        >
          <SettingsIcon />
        </button>
      </header>

      <main className="body">
        {target.kind === 'loading' && (
          <div className="skeleton" role="status" aria-label="Checking this tab">
            <span className="bar bar-a" />
            <span className="bar bar-b" />
          </div>
        )}

        {target.kind === 'unknown' && (
          <p className="lede">
            This tab can't be read right now. Try reopening this popup on the
            tab you want to render.
          </p>
        )}

        {target.kind === 'restricted' && (
          <p className="lede">
            This is a browser page. Extensions aren't allowed to run here, so
            there's nothing to render.
          </p>
        )}

        {target.kind === 'plain' && (
          <>
            <p className="lede">
              This page isn't a markdown file, so there's nothing to render.
            </p>
            <p className="sub">
              Open a <code>.md</code>, <code>.markdown</code>, <code>.mkd</code>{' '}
              or <code>.mdx</code> file and this popup will offer to render it.
            </p>
          </>
        )}

        {target.kind === 'file' && !fileAccess && (
          <>
            <p className="lede">
              This is a local file. Chrome keeps local files off-limits to
              extensions until you allow it — a browser switch only you can
              flip.
            </p>
            <p className="sub">
              Settings has the three steps, and a link you can paste.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={openSettings}
              >
                Open settings
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => {
                  setNotice(null);
                  void detect();
                }}
              >
                Check again
              </button>
            </div>
          </>
        )}

        {target.kind === 'file' && fileAccess && (
          <>
            <p className="lede">
              Local file: <strong className="filename">{target.name}</strong>
            </p>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void handleRender(target.tabId)}
            >
              {busy === 'render' ? 'Rendering…' : 'Render this page'}
            </button>
            <p className="tier-note">
              <CheckIcon />
              Local markdown files are set to render on their own. Use the
              button if a file was already open.
            </p>
          </>
        )}

        {/*
          Automatic rendering is on, so the buttons below would be busywork:
          this page rendered itself, and a per-site grant adds nothing to an
          all-sites one. The exception is a tab that was already open when the
          setting was turned on — that one still shows raw text, and saying
          otherwise would be a lie the user can see through.
        */}
        {target.kind === 'web' && autoRender && (
          <>
            {renderState === 'rendered' ? (
              <>
                <p className="lede state-ok">
                  <CheckIcon />
                  Rendered automatically.
                </p>
                <p className="sub">
                  Markdown files render as they load, on every site. There's
                  nothing to do here.
                </p>
              </>
            ) : (
              <>
                <p className="lede">
                  {renderState === 'raw'
                    ? 'This tab was already open when automatic rendering was turned on, so it still shows raw text.'
                    : 'Automatic rendering is on for pages opened from now on. This tab may predate it.'}
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void handleRender(target.tabId)}
                >
                  {busy === 'render' ? 'Rendering…' : 'Render this page'}
                </button>
              </>
            )}
            <p className="sub sub-link">
              <button type="button" className="link" onClick={openSettings}>
                Settings
              </button>{' '}
              turns automatic rendering back off.
            </p>
          </>
        )}

        {target.kind === 'web' && !autoRender && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => void handleRender(target.tabId)}
            >
              {busy === 'render' ? 'Rendering…' : 'Render this page'}
            </button>
            <p className="tier-note">
              Works right now, with no permission prompt. Nothing is remembered.
            </p>

            <div className="tier">
              {granted ? (
                <>
                  <p className="tier-title">
                    <CheckIcon />
                    Rendering automatically on{' '}
                    <span className="host">{target.host}</span>
                  </p>
                  <p className="tier-note">
                    Markdown files on this site render as they load.
                  </p>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={busy !== null}
                    onClick={() => handleRevoke(target.pattern, target.host)}
                  >
                    {busy === 'revoke'
                      ? 'Removing…'
                      : `Stop rendering on ${target.host}`}
                  </button>
                </>
              ) : (
                <>
                  <p className="tier-title">
                    Optional: <span className="host">{target.host}</span>
                  </p>
                  <p className="tier-note">
                    Chrome will ask before granting access to this one site.
                    Markdown files here would then render as they load. You can
                    undo it from this popup at any time.
                  </p>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={busy !== null}
                    onClick={() =>
                      handleGrant(target.pattern, target.host, target.tabId)
                    }
                  >
                    {busy === 'grant'
                      ? 'Asking…'
                      : `Always render on ${target.host}`}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        <p
          className={notice ? `notice is-${notice.tone}` : 'notice'}
          role="status"
          aria-live="polite"
        >
          {notice?.text ?? ''}
        </p>
      </main>

      <footer className="foot">
        <ThemePicker theme={theme} onChange={chooseTheme} />
      </footer>
    </div>
  );
}

export default App;
