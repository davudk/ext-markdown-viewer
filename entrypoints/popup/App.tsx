import { useCallback, useEffect, useState } from 'react';

import { isCandidateUrl, originPattern } from '@/lib/detect';
import {
  sendMessage,
  type RenderTabResult,
  type SyncResult,
} from '@/lib/messages';
import {
  DEFAULT_SETTINGS,
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

type Notice = { tone: 'ok' | 'error'; text: string };

type Busy = 'render' | 'grant' | 'revoke' | null;

/** Pages no extension can touch, so the popup explains rather than offers. */
const RESTRICTED_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'edge:',
  'brave:',
  'about:',
  'devtools:',
  'view-source:',
  'chrome-extension:',
  'moz-extension:',
];

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '').trim();
  return text || 'Something went wrong.';
}

/** Optional across browsers and versions, so the call itself has to be guarded. */
async function hasFileAccess(): Promise<boolean> {
  try {
    return (await chrome.extension?.isAllowedFileSchemeAccess?.()) ?? false;
  } catch {
    return false;
  }
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

async function resolveTarget(): Promise<{
  target: Target;
  granted: boolean;
  fileAccess: boolean;
}> {
  const idle = { granted: false, fileAccess: false };

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
    const fileAccess = await hasFileAccess();
    return {
      target: { kind: 'file', tabId: tab.id, name: fileName(url) },
      granted: false,
      fileAccess,
    };
  }

  const pattern = originPattern(tab.url);
  if (!pattern) {
    return { target: { kind: 'plain', label: pageLabel(url) }, ...idle };
  }

  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    // Treat an unreadable permission state as "not granted": the worst case is
    // offering a grant the user already has, which Chrome resolves instantly.
  }

  return {
    target: { kind: 'web', tabId: tab.id, host: url.hostname, pattern },
    granted,
    fileAccess: false,
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

function CopyIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="5.75"
        y="5.75"
        width="8.5"
        height="8.5"
        rx="1.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M10.25 3.5A1.75 1.75 0 008.5 1.75h-4.75A1.75 1.75 0 002 3.5v4.75c0 .97.78 1.75 1.75 1.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
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

const THEMES: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'auto', label: 'Auto' },
];

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
        {THEMES.map(({ value, label }) => (
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
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<Theme>(DEFAULT_SETTINGS.theme);

  const detect = useCallback(async () => {
    try {
      const next = await resolveTarget();
      setTarget(next.target);
      setGranted(next.granted);
      setFileAccess(next.fileAccess);

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

  /** Tier 1: inject via the activeTab grant. Never shows a permission prompt. */
  const render = useCallback(
    async (tabId: number, quiet = false): Promise<boolean> => {
      try {
        const result = await sendMessage<RenderTabResult>({
          type: 'RENDER_TAB',
          tabId,
        });
        if (result?.ok) {
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

    chrome.permissions
      .remove({ origins: [pattern] })
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

  const detailsUrl = `chrome://extensions/?id=${chrome.runtime.id}`;

  const copyDetailsUrl = async () => {
    try {
      await navigator.clipboard.writeText(detailsUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({
        tone: 'error',
        text: 'Copying failed — select the address above and copy it manually.',
      });
    }
  };

  return (
    <div className="popup">
      <header className="head">
        <MarkIcon />
        <h1>Markdown Viewer</h1>
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
              extensions until you allow it — and only you can turn that on.
            </p>
            <ol className="steps">
              <li>
                Paste this into the address bar (Chrome blocks links to it):
                <span className="path">
                  <code>{detailsUrl}</code>
                  <button
                    type="button"
                    className="btn btn-icon"
                    onClick={copyDetailsUrl}
                  >
                    <CopyIcon />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </span>
              </li>
              <li>
                Turn on <strong>Allow access to file URLs</strong>.
              </li>
              <li>Come back here and reload the file.</li>
            </ol>
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

        {target.kind === 'web' && (
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
