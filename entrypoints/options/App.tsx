import { useCallback, useEffect, useRef, useState } from 'react';

import { sendMessage, type SyncResult } from '@/lib/messages';
import {
  disableAutoRender,
  hasFileAccess,
  isAutoRenderEnabled,
  listGrantedOrigins,
  originLabel,
  requestAutoRender,
  revokeOrigin,
} from '@/lib/permissions';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  saveSettings,
  type Theme,
} from '@/lib/settings';
import './App.css';

/**
 * Everything the page can grant or revoke, read straight from the browser.
 *
 * None of it is stored: the permission state is the source of truth, so a
 * control here can never claim access Chrome has already taken away. It is all
 * resolved in one pass so the sections have no async holes to flash through.
 */
interface Access {
  /** Holds the all-sites permission right now. */
  autoRender: boolean;
  /** The browser-level "Allow access to file URLs" toggle. */
  fileAccess: boolean;
  /** Individually granted origins, all-sites excluded. */
  sites: string[];
}

type State =
  /** First read in flight; the permission sections show a skeleton. */
  | { kind: 'loading' }
  /** No extension APIs — nothing here can be read, let alone changed. */
  | { kind: 'unavailable' }
  | { kind: 'ready'; access: Access };

/** Which section a message belongs under, so it lands next to its control. */
type Section = 'rendering' | 'files' | 'sites';

type Notice = { tone: 'ok' | 'info' | 'error'; text: string };

/** At most one operation at a time, and the UI needs to know which. */
type Busy =
  | { kind: 'auto' }
  | { kind: 'file' }
  | { kind: 'site'; origin: string }
  | null;

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '').trim();
  return text || 'Something went wrong.';
}

/**
 * Guarded because this file is also type-checked and bundled outside a live
 * extension context, where `chrome` exists in the types but not at runtime.
 */
function hasExtensionApis(): boolean {
  try {
    return Boolean(chrome?.permissions && chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** The details page can't be linked to, only quoted, so it has to be built. */
function extensionId(): string {
  try {
    return chrome.runtime?.id ?? '';
  } catch {
    return '';
  }
}

function readManifest(): { name: string; version: string } {
  try {
    const manifest = chrome.runtime.getManifest();
    return {
      name: manifest.name || 'Markdown Viewer',
      version: manifest.version || 'unknown',
    };
  } catch {
    return { name: 'Markdown Viewer', version: 'unknown' };
  }
}

/**
 * Ask the service worker to re-derive its content-script registrations. It also
 * listens for permission events itself, so a failure here is recoverable rather
 * than fatal — except for file access, which no event covers.
 */
function syncRegistrations(): Promise<SyncResult | undefined> {
  return sendMessage<SyncResult>({ type: 'SYNC_REGISTRATIONS' }).catch(
    () => undefined,
  );
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

/** A live region that is always in the DOM, so async results get announced. */
function Message({ notice }: { notice: Notice | null }) {
  return (
    <p
      className={notice ? `msg is-${notice.tone}` : 'msg'}
      role="status"
      aria-live="polite"
    >
      {notice?.text ?? ''}
    </p>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span className="bar bar-a" />
      <span className="bar bar-b" />
    </div>
  );
}

function Unavailable() {
  return (
    <p className="row-desc">
      This page can't reach the extension right now. Reopen it from the
      extension's toolbar icon.
    </p>
  );
}

function Switch({
  on,
  busy,
  disabled,
  labelledBy,
  describedBy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  labelledBy: string;
  describedBy: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<Busy>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<Theme>(DEFAULT_SETTINGS.theme);
  const [app] = useState(readManifest);

  /** Last file-access value we acted on, so a flip to on syncs exactly once. */
  const lastFileAccess = useRef<boolean | null>(null);

  /**
   * Whether an action of ours is in flight, and the last permission state we
   * showed. Together these tell an external change (chrome://extensions, another
   * tab) apart from the echo of our own click — see `refresh`.
   */
  const busyRef = useRef<Busy>(null);
  const lastGrants = useRef<string | null>(null);

  const say = useCallback((where: Section, tone: Notice['tone'], text: string) => {
    setSection(where);
    setNotice({ tone, text });
  }, []);

  const clear = useCallback(() => {
    setSection(null);
    setNotice(null);
  }, []);

  /**
   * Re-read every permission from the browser. Called on load, after each
   * change, and whenever the page comes back into view — another tab, or
   * chrome://extensions, can have changed all of this behind our back.
   */
  const refresh = useCallback(async (): Promise<Access | null> => {
    if (!hasExtensionApis()) {
      setState({ kind: 'unavailable' });
      return null;
    }

    const [autoRender, fileAccess, sites] = await Promise.all([
      isAutoRenderEnabled(),
      hasFileAccess(),
      listGrantedOrigins(),
    ]);
    const access: Access = { autoRender, fileAccess, sites };
    setState({ kind: 'ready', access });

    // A notice describes the state it was written against. If permissions moved
    // while no action of ours was running, someone changed them elsewhere and
    // the message on screen is now describing something that is no longer true
    // — an "Automatic rendering is on" line sitting under a switch reading off.
    const grants = JSON.stringify([autoRender, sites]);
    if (
      lastGrants.current !== null &&
      lastGrants.current !== grants &&
      busyRef.current === null
    ) {
      clear();
    }
    lastGrants.current = grants;

    // The file toggle lives outside the extension and fires no permission
    // event, so this sync is the only thing that picks it up.
    if (fileAccess && lastFileAccess.current !== true) {
      lastFileAccess.current = true;
      const result = await syncRegistrations();
      if (!result?.ok) {
        say(
          'files',
          'error',
          "File access is on, but the extension couldn't update itself to use it. Reload this page, or restart the browser.",
        );
      }
    } else {
      lastFileAccess.current = fileAccess;
    }

    return access;
  }, [say, clear]);

  // Mirrored into a ref so `refresh` can read it without taking it as a
  // dependency and rebuilding on every busy transition.
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    void refresh().catch(() => setState({ kind: 'unavailable' }));
    void loadSettings().then((settings) => setTheme(settings.theme));
  }, [refresh]);

  // The popup writes the same setting, so mirror it rather than drift from it.
  useEffect(() => onSettingsChanged((next) => setTheme(next.theme)), []);

  // Match the page to the documents it renders. `auto` defers to the OS via
  // prefers-color-scheme; an explicit choice overrides it in both directions.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Permissions can change in another tab or from chrome://extensions while
  // this page sits open. Re-read on return rather than showing a stale switch.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // And live, when the change happens while the page is already in view.
  useEffect(() => {
    const onPermissionChange = () => void refresh().catch(() => undefined);
    try {
      chrome.permissions.onAdded.addListener(onPermissionChange);
      chrome.permissions.onRemoved.addListener(onPermissionChange);
    } catch {
      return;
    }
    return () => {
      try {
        chrome.permissions.onAdded.removeListener(onPermissionChange);
        chrome.permissions.onRemoved.removeListener(onPermissionChange);
      } catch {
        // The context is already gone; there is nothing left to detach from.
      }
    };
  }, [refresh]);

  const chooseTheme = (next: Theme) => {
    setTheme(next);
    // Open documents and the popup restyle themselves off the storage change;
    // a failed write shouldn't take the rest of the page down with it.
    void saveSettings({ theme: next }).catch(() => undefined);
  };

  /**
   * `permissions.request()` must be the first thing this handler does: awaiting
   * anything before it spends the user gesture and Chrome rejects the call.
   * The two `setState` calls above it are synchronous, so they are safe.
   */
  const toggleAutoRender = (next: boolean) => {
    clear();
    setBusy({ kind: 'auto' });

    const change = next ? requestAutoRender() : disableAutoRender();

    change
      .then(async (ok) => {
        if (!ok) {
          // Declining is a normal answer, not a failure, and not an opening to
          // ask again. Removal failing genuinely is a problem.
          if (next) {
            say('rendering', 'info', 'Automatic rendering is still off.');
          } else {
            say('rendering', 'error', "Couldn't turn automatic rendering off.");
          }
          return;
        }

        await syncRegistrations();
        await refresh();
        say(
          'rendering',
          'ok',
          next
            ? 'Automatic rendering is on. Markdown files render as they open, on any site.'
            : 'Automatic rendering is off. Sites in the list below still render on their own.',
        );
      })
      .catch((error) => say('rendering', 'error', describeError(error)))
      .finally(() => setBusy(null));
  };

  const handleRevoke = (origin: string) => {
    const label = originLabel(origin);
    clear();
    setBusy({ kind: 'site', origin });

    revokeOrigin(origin)
      .then(async (removed) => {
        if (!removed) {
          say('sites', 'error', `Couldn't remove access to ${label}.`);
          return;
        }
        await syncRegistrations();
        await refresh();
        say('sites', 'ok', `Removed access to ${label}.`);
      })
      .catch((error) => say('sites', 'error', describeError(error)))
      .finally(() => setBusy(null));
  };

  const recheckFileAccess = async () => {
    clear();
    setBusy({ kind: 'file' });
    try {
      const access = await refresh();
      if (!access) return;
      if (access.fileAccess) {
        say('files', 'ok', 'Local files are allowed. Nothing else to do.');
      } else {
        say(
          'files',
          'info',
          'Still off. Chrome only registers the change once the toggle on the details page is on.',
        );
      }
    } catch (error) {
      say('files', 'error', describeError(error));
    } finally {
      setBusy(null);
    }
  };

  const detailsUrl = `chrome://extensions/?id=${extensionId()}`;

  const copyDetailsUrl = async () => {
    try {
      await navigator.clipboard.writeText(detailsUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      say(
        'files',
        'error',
        'Copying failed — select the address above and copy it manually.',
      );
    }
  };

  const noticeFor = (where: Section) => (section === where ? notice : null);
  const ready = state.kind === 'ready' ? state.access : null;
  const locked = busy !== null;

  return (
    <div className="page">
      <header className="masthead">
        <MarkIcon />
        <div>
          <h1>Markdown Viewer</h1>
          <p className="masthead-sub">Settings</p>
        </div>
      </header>

      <main>
        {/* Rendering ---------------------------------------------------- */}
        <section className="card" aria-labelledby="rendering-h">
          <div className="card-head">
            <h2 id="rendering-h">Rendering</h2>
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="auto-label">
                Render markdown automatically on every site
              </h3>
              <div className="row-desc" id="auto-desc">
                <p>
                  Markdown files render the moment they open, anywhere, without
                  clicking the toolbar icon.
                </p>
                <p>
                  Chrome will ask you to allow this extension to read and change
                  your data on all sites, and that is what it grants. There is no
                  narrower way to do it: Chrome gives extensions no way to
                  register a handler for a file type, so replacing a page the
                  browser has already decided to show as plain text means being
                  allowed to run on that page. The extension only injects into
                  addresses ending in <code>.md</code>, <code>.markdown</code>,{' '}
                  <code>.mkd</code> or <code>.mdx</code>, and you can turn this
                  off here at any time.
                </p>
                {ready && !ready.autoRender && (
                  <p>
                    Left off, you can still render any file from the toolbar
                    icon, or allow individual sites one at a time.
                  </p>
                )}
              </div>
            </div>

            {state.kind === 'loading' && (
              <span className="pill" role="status" aria-label="Checking permissions">
                Checking…
              </span>
            )}
            {ready && (
              <Switch
                on={ready.autoRender}
                busy={busy?.kind === 'auto'}
                disabled={locked}
                labelledBy="auto-label"
                describedBy="auto-desc"
                onChange={toggleAutoRender}
              />
            )}
          </div>

          {state.kind === 'unavailable' && (
            <div className="row">
              <Unavailable />
            </div>
          )}

          <div className="row row-quiet">
            <Message notice={noticeFor('rendering')} />
          </div>
        </section>

        {/* Local files -------------------------------------------------- */}
        <section className="card" aria-labelledby="files-h">
          <div className="card-head">
            <h2 id="files-h">Local files</h2>
          </div>

          <div className="row row-stack">
            {state.kind === 'loading' && (
              <Skeleton label="Checking local file access" />
            )}

            {state.kind === 'unavailable' && <Unavailable />}

            {ready?.fileAccess && (
              <>
                <h3 className="row-title row-title-ok">
                  <CheckIcon />
                  Local files are allowed
                </h3>
                <p className="row-desc">
                  Markdown files you open from your computer render on their own.
                  Chrome shows this as <strong>Allow access to file URLs</strong>{' '}
                  on the extension's details page, and it can be turned back off
                  there.
                </p>
              </>
            )}

            {ready && !ready.fileAccess && (
              <>
                <h3 className="row-title">Local files are not allowed</h3>
                <p className="row-desc">
                  Chrome keeps <code>file:///</code> addresses off-limits to
                  extensions until you allow it. This one is a browser setting
                  rather than a permission, so the extension cannot ask for it —
                  Chrome does not accept <code>file:///*</code> through a
                  permission prompt. Only you can turn it on:
                </p>
                <ol className="steps">
                  <li>
                    Paste this into the address bar (Chrome blocks links to it):
                    <span className="path">
                      <code>{detailsUrl}</code>
                      <button
                        type="button"
                        className="btn btn-icon"
                        onClick={() => void copyDetailsUrl()}
                      >
                        <CopyIcon />
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </span>
                  </li>
                  <li>
                    Turn on <strong>Allow access to file URLs</strong>.
                  </li>
                  <li>Come back here and check again.</li>
                </ol>
              </>
            )}

            {ready && (
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={locked}
                  onClick={() => void recheckFileAccess()}
                >
                  {busy?.kind === 'file' ? 'Checking…' : 'Check again'}
                </button>
              </div>
            )}

            <Message notice={noticeFor('files')} />
          </div>
        </section>

        {/* Sites -------------------------------------------------------- */}
        <section className="card" aria-labelledby="sites-h">
          <div className="card-head">
            <h2 id="sites-h">Sites</h2>
          </div>

          <div className="row row-stack">
            <p className="row-desc">
              Every site you have allowed individually. This is the whole list —
              nothing renders automatically on a site that isn't here, unless the
              switch above is on.
            </p>

            {state.kind === 'loading' && <Skeleton label="Loading allowed sites" />}

            {state.kind === 'unavailable' && <Unavailable />}

            {ready?.autoRender && ready.sites.length > 0 && (
              <p className="note">
                Automatic rendering already covers every site, so these grants
                add nothing while it stays on. They take over again if you turn
                it off.
              </p>
            )}

            {ready && ready.sites.length === 0 && (
              <p className="empty">
                No sites yet. Open a markdown file, click the extension's toolbar
                icon and choose <strong>Always render on this site</strong> to
                add one.
              </p>
            )}

            {ready && ready.sites.length > 0 && (
              <ul className="sites">
                {ready.sites.map((origin) => {
                  const label = originLabel(origin);
                  const removing =
                    busy?.kind === 'site' && busy.origin === origin;
                  return (
                    <li key={origin} className="site">
                      <span className="site-name">{label}</span>
                      <button
                        type="button"
                        className="btn btn-quiet btn-inline"
                        aria-label={`Remove access to ${label}`}
                        disabled={locked}
                        onClick={() => handleRevoke(origin)}
                      >
                        {removing ? 'Removing…' : 'Remove'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <Message notice={noticeFor('sites')} />
          </div>
        </section>

        {/* Appearance --------------------------------------------------- */}
        <section className="card" aria-labelledby="appearance-h">
          <div className="card-head">
            <h2 id="appearance-h">Appearance</h2>
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="theme-label">
                Theme
              </h3>
              <p className="row-desc">
                Applies to rendered documents, the popup and this page.{' '}
                <strong>Auto</strong> follows your system setting; light and dark
                override it in both directions.
              </p>
            </div>

            <div
              className="segmented"
              role="radiogroup"
              aria-labelledby="theme-label"
            >
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
                    onChange={() => chooseTheme(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* About -------------------------------------------------------- */}
        <section className="card" aria-labelledby="about-h">
          <div className="card-head">
            <h2 id="about-h">About</h2>
          </div>

          <div className="row row-stack">
            <h3 className="row-title">
              {app.name} <span className="version">version {app.version}</span>
            </h3>
            <ul className="facts">
              <li>The extension makes no network requests.</li>
              <li>There is no analytics, telemetry, or crash reporting.</li>
              <li>There are no accounts and nothing to sign in to.</li>
              <li>
                Settings are stored locally in this browser, in{' '}
                <code>chrome.storage.local</code>, and are never synced.
              </li>
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
