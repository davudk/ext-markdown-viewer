import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';

// Straight from config rather than through settings.ts, which re-exports only
// the theme surface. These are static tables, not behaviour — see config.ts.
import { DOCUMENT_THEME_LIMIT } from '@/lib/config';
import { sendMessage, type SyncResult } from '@/lib/messages';
import { readPluginFailures, type PluginFailures } from '@/lib/plugin-failures';
import {
  exportSettings,
  importSettings,
  type ImportResult,
} from '@/lib/settings-io';
import {
  clearAllDocumentThemes,
  clearDocumentTheme,
  getPreset,
  listDocumentThemes,
  resolvePolarity,
  type DocumentTheme,
  type DocumentThemeEntry,
  type ThemePresetId,
} from '@/lib/theme-presets';
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
  THEME_OPTIONS,
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  saveSettings,
  type Settings,
  type Theme,
} from '@/lib/settings';
import { Message, Skeleton, Switch, Unavailable, type Notice } from './controls';
import { PluginSection } from './PluginSection';
import { ThemePanel } from './ThemePanel';
import { TypographyPanel, type Reading } from './TypographyPanel';
import { Toc } from './Toc';
import {
  ALL_SECTION_IDS,
  PLUGIN_GROUPS,
  pluginSectionId,
} from './sections';
import {
  emptySettings,
  onPluginSettingsChanged,
  readPluginSettings,
  withEnabled,
  withSetting,
  writePluginSettings,
  type StoredSettings,
} from './plugins';
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

/**
 * Which section a message belongs under, so it lands next to its control.
 *
 * `theme` and `typography` are the plugins that own those settings rather than
 * the old page-wide `general`: a notice about the reader's stylesheet now
 * appears inside the theme plugin's card, where the control that produced it
 * is.
 */
type Section =
  | 'rendering'
  | 'files'
  | 'sites'
  | 'pins'
  | 'backup'
  | 'theme'
  | 'typography';

function pickReading(settings: Settings): Reading {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    contentWidth: settings.contentWidth,
  };
}

const READING_DEFAULTS: Reading = pickReading(DEFAULT_SETTINGS);

/** `example.com/docs/notes.md`, or the whole thing if it will not parse. */
function documentLabel(key: string): string {
  try {
    const url = new URL(key);
    return decodeURIComponent(`${url.host}${url.pathname}${url.search}`) || key;
  } catch {
    return key;
  }
}

/** "Dark · Gruvbox", or just whichever half was pinned. */
function describePin(override: DocumentTheme): string {
  const parts: string[] = [];
  if (override.theme) {
    parts.push(
      THEME_OPTIONS.find((option) => option.value === override.theme)?.label ??
        override.theme,
    );
  }
  if (override.preset) parts.push(getPreset(override.preset).label);
  return parts.join(' · ');
}

/**
 * How long a slider may keep moving before its value is written.
 *
 * Long enough that a drag collapses into one or two writes instead of sixty a
 * second, short enough that letting go feels like it took effect immediately.
 * Only the write waits — the number on screen and the preview never do.
 */
const WRITE_DELAY_MS = 150;

/** At most one operation at a time, and the UI needs to know which. */
type Busy =
  | { kind: 'auto' }
  | { kind: 'file' }
  | { kind: 'site'; origin: string }
  | { kind: 'pin'; key: string }
  | { kind: 'pins' }
  | { kind: 'export' }
  | { kind: 'import' }
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

function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState<Busy>(null);
  const [section, setSection] = useState<Section | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState<Theme>(DEFAULT_SETTINGS.theme);
  const [preset, setPreset] = useState<ThemePresetId>(DEFAULT_SETTINGS.themePreset);
  const [customCss, setCustomCss] = useState(DEFAULT_SETTINGS.customCss);
  const [reading, setReading] = useState<Reading>(READING_DEFAULTS);
  const [pins, setPins] = useState<DocumentThemeEntry[] | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [app] = useState(readManifest);

  /** Every plugin's enabled flag and settings, as one blob. See `plugins.ts`. */
  const [plugins, setPlugins] = useState<StoredSettings>(emptySettings);
  /** Why the host switched a plugin off during the last render, if it did. */
  const [failures, setFailures] = useState<PluginFailures>({});

  /**
   * Which half of a preset the preview shows. `auto` has no colour of its own,
   * so the only honest preview is the one the reader would actually get, which
   * means asking the OS the same question the viewer asks it.
   */
  const [prefersDark, setPrefersDark] = useState(false);

  /**
   * A write that has been decided but not yet made, and the timer that will
   * make it. Held in refs, not state: nothing on screen depends on them, and
   * re-rendering mid-drag for a bookkeeping change would be pure waste.
   */
  const queued = useRef<Partial<Settings> | null>(null);
  const writeTimer = useRef<number | null>(null);

  /** The same pair for plugin settings, which live under their own key. */
  const queuedPlugins = useRef<StoredSettings | null>(null);
  const pluginTimer = useRef<number | null>(null);

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

  /** Write whatever is queued right now, cancelling any pending timer. */
  const flushWrite = useCallback(() => {
    if (writeTimer.current !== null) {
      window.clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    const patch = queued.current;
    queued.current = null;
    if (!patch) return;
    // Open documents and the popup restyle themselves off the storage change;
    // a failed write shouldn't take the rest of the page down with it.
    void saveSettings(patch).catch(() => undefined);
  }, []);

  const flushPlugins = useCallback(() => {
    if (pluginTimer.current !== null) {
      window.clearTimeout(pluginTimer.current);
      pluginTimer.current = null;
    }
    const next = queuedPlugins.current;
    queuedPlugins.current = null;
    if (!next) return;
    void writePluginSettings(next).catch(() => undefined);
  }, []);

  /**
   * Apply a typography setting. The screen updates synchronously in every case;
   * `defer` only delays the storage write, and is used by the sliders, which
   * fire an event for every pixel of a drag.
   *
   * Patches accumulate rather than replace, so dragging the size slider and
   * then the line-height slider inside one window still writes both.
   */
  const applyReading = useCallback(
    (patch: Partial<Reading>, defer = false) => {
      setReading((prev) => ({ ...prev, ...patch }));
      queued.current = { ...queued.current, ...patch };

      if (!defer) {
        flushWrite();
        return;
      }
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      writeTimer.current = window.setTimeout(flushWrite, WRITE_DELAY_MS);
    },
    [flushWrite],
  );

  /**
   * The same shape for the plugin blob. The whole blob is queued rather than a
   * patch: it is one storage key, so the last state to reach here is exactly
   * what should be written, and there is nothing to merge.
   */
  const applyPlugins = useCallback(
    (next: StoredSettings, defer = false) => {
      setPlugins(next);
      queuedPlugins.current = next;

      if (!defer) {
        flushPlugins();
        return;
      }
      if (pluginTimer.current !== null) window.clearTimeout(pluginTimer.current);
      pluginTimer.current = window.setTimeout(flushPlugins, WRITE_DELAY_MS);
    },
    [flushPlugins],
  );

  /**
   * The stylesheet, on the same deferred write as the sliders and for the same
   * reason: a keystroke is not a decision, and writing on every one of them
   * would republish the sheet to every open document mid-word.
   */
  const applyCustomCss = useCallback(
    (next: string) => {
      setCustomCss(next);
      queued.current = { ...queued.current, customCss: next };

      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      writeTimer.current = window.setTimeout(flushWrite, WRITE_DELAY_MS);
    },
    [flushWrite],
  );

  const resetReading = () => {
    applyReading(READING_DEFAULTS);
    say('typography', 'ok', 'Typography is back to its defaults.');
  };

  // A queued write is lost if the page goes away first, and an options page is
  // usually closed the instant the last slider is released. `pagehide` is the
  // one event that still fires when the tab is closed or put in the bfcache.
  useEffect(() => {
    const onHide = () => {
      flushWrite();
      flushPlugins();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushWrite();
      flushPlugins();
    };
  }, [flushWrite, flushPlugins]);

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

  /** Re-read the pinned documents. Cheap, and always from storage. */
  const refreshPins = useCallback(async () => {
    try {
      setPins(await listDocumentThemes());
    } catch {
      setPins([]);
    }
  }, []);

  useEffect(() => {
    void refreshPins();
  }, [refreshPins]);

  // Mirrored into a ref so `refresh` can read it without taking it as a
  // dependency and rebuilding on every busy transition.
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    void refresh().catch(() => setState({ kind: 'unavailable' }));
    void loadSettings().then((settings) => {
      setTheme(settings.theme);
      setPreset(settings.themePreset);
      setCustomCss(settings.customCss);
      setReading(pickReading(settings));
    });
    void readPluginSettings().then(setPlugins);
    void readPluginFailures().then(setFailures);
  }, [refresh]);

  // The popup writes the same settings, so mirror them rather than drift.
  useEffect(
    () =>
      onSettingsChanged((next) => {
        setTheme(next.theme);
        setPreset(next.themePreset);
        // Our own debounced writes come back through this listener too. While
        // one is still queued, storage is a step behind what is on screen, and
        // adopting it would snap a slider back under the user's cursor — or, in
        // the editor below, move the caret out from under them mid-word.
        if (queued.current === null) {
          setReading(pickReading(next));
          setCustomCss(next.customCss);
        }
      }),
    [],
  );

  // The command palette can toggle a plugin from an open document. Same guard
  // as above: a write of ours still in flight is ahead of storage, not behind.
  useEffect(
    () =>
      onPluginSettingsChanged((next) => {
        if (queuedPlugins.current === null) setPlugins(next);
      }),
    [],
  );

  // `auto` has no colour of its own, so the preview has to ask the OS the same
  // question the viewer asks it, and keep asking.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setPrefersDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

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
        // A document can have been pinned in another tab while this page sat
        // open; the list is only useful if it is the current one.
        void refreshPins();
        // And a document opened meanwhile may have hit a plugin that throws.
        void readPluginFailures().then(setFailures);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh, refreshPins]);

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

  const choosePreset = (next: ThemePresetId) => {
    setPreset(next);
    void saveSettings({ themePreset: next }).catch(() => undefined);
  };

  const unpin = (key: string) => {
    clear();
    setBusy({ kind: 'pin', key });

    clearDocumentTheme(key)
      .then(async () => {
        await refreshPins();
        say('pins', 'ok', `${documentLabel(key)} follows your global theme again.`);
      })
      .catch((error) => say('pins', 'error', describeError(error)))
      .finally(() => setBusy(null));
  };

  const unpinAll = () => {
    clear();
    setBusy({ kind: 'pins' });

    clearAllDocumentThemes()
      .then(async () => {
        await refreshPins();
        say('pins', 'ok', 'Every document follows your global theme again.');
      })
      .catch((error) => say('pins', 'error', describeError(error)))
      .finally(() => setBusy(null));
  };

  const handleExport = () => {
    clear();
    setImported(null);
    setBusy({ kind: 'export' });

    // Read from storage rather than from the state above: this page shows some
    // settings and not others, and a backup that only covered the ones on
    // screen would be a backup in name.
    loadSettings()
      .then((settings) => exportSettings(settings))
      .then(({ filename }) =>
        say('backup', 'ok', `Saved ${filename}. It contains settings only — no documents, and nothing about what you have read.`),
      )
      .catch((error) => say('backup', 'error', describeError(error)))
      .finally(() => setBusy(null));
  };

  /**
   * Reading the file is the only asynchronous part; validation and the write
   * are one step, so there is no window in which half a file has been applied.
   */
  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared immediately, so choosing the same file twice fires again — which
    // is exactly what someone does after fixing a file the import complained
    // about.
    event.target.value = '';
    if (!file) return;

    clear();
    setImported(null);
    setBusy({ kind: 'import' });

    try {
      const result = await importSettings(await file.text());
      setImported(result);

      if (!result.ok) {
        say('backup', 'error', result.error);
        return;
      }

      const settings = await loadSettings();
      setTheme(settings.theme);
      setPreset(settings.themePreset);
      setCustomCss(settings.customCss);
      setReading(pickReading(settings));

      say(
        'backup',
        result.notes.length > 0 ? 'info' : 'ok',
        result.notes.length > 0
          ? `Imported ${file.name}, with the changes listed below.`
          : `Imported ${file.name}. Every setting in it was applied.`,
      );
    } catch (error) {
      say('backup', 'error', describeError(error));
    } finally {
      setBusy(null);
    }
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

  /** The half of the preset the reader would actually be shown right now. */
  const polarity = resolvePolarity(theme, prefersDark);

  /**
   * The rows a plugin owns but does not store, keyed by plugin id.
   *
   * The only place the page says which plugin a global belongs to, and it says
   * it once — `owned.ts` holds the declaration, `PluginSection` renders
   * whatever it is handed, and every other section is generated exactly as
   * before.
   */
  const ownedPanels: Record<string, ReactNode> = {
    theme: (
      <ThemePanel
        theme={theme}
        preset={preset}
        customCss={customCss}
        polarity={polarity}
        notice={noticeFor('theme')}
        onTheme={chooseTheme}
        onPreset={choosePreset}
        onCustomCss={applyCustomCss}
        onClearCss={() => {
          applyCustomCss('');
          say('theme', 'ok', 'Your stylesheet is empty again.');
        }}
      />
    ),
    typography: (
      <TypographyPanel
        reading={reading}
        notice={noticeFor('typography')}
        onChange={applyReading}
        onReset={resetReading}
      />
    ),
  };

  return (
    <div className="page">
      <header className="masthead">
        <MarkIcon />
        <div>
          <h1>Markdown Viewer</h1>
          <p className="masthead-sub">Settings</p>
        </div>
      </header>

      <div className="shell">
        <div className="rail">
          <Toc sectionIds={ALL_SECTION_IDS} />

          {/* Provenance rather than a setting, so it sits under the contents
              instead of taking a place in it. */}
          <footer className="colophon">
            <p className="colophon-name">
              {app.name} <span className="version">version {app.version}</span>
            </p>
            <ul className="facts">
              <li>The extension makes no network requests.</li>
              <li>There is no analytics, telemetry, or crash reporting.</li>
              <li>There are no accounts and nothing to sign in to.</li>
              <li>
                Settings are stored locally in this browser, in{' '}
                <code>chrome.storage.local</code>, and are never synced.
              </li>
            </ul>
          </footer>
        </div>

        <main className="content">
          {/* Rendering ---------------------------------------------------- */}
          <section
            className="card"
            id="sec-rendering"
            aria-labelledby="rendering-h"
            tabIndex={-1}
          >
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
          <section
            className="card"
            id="sec-files"
            aria-labelledby="files-h"
            tabIndex={-1}
          >
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
          <section
            className="card"
            id="sec-sites"
            aria-labelledby="sites-h"
            tabIndex={-1}
          >
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

          {/* Pinned documents --------------------------------------------- */}
          <section
            className="card"
            id="sec-pins"
            aria-labelledby="pins-h"
            tabIndex={-1}
          >
            <div className="card-head">
              <h2 id="pins-h">Pinned documents</h2>
            </div>

            <div className="row row-stack">
              <p className="row-desc">
                Documents you have given a theme of their own from the viewer.
                Each one ignores the global theme until it is unpinned. The last{' '}
                {DOCUMENT_THEME_LIMIT} are kept; beyond that the least recently
                opened is forgotten.
              </p>

              {pins === null && <Skeleton label="Loading pinned documents" />}

              {pins?.length === 0 && (
                <p className="empty">
                  Nothing is pinned. Every document follows the theme and preset
                  set under the Theme plugin.
                </p>
              )}

              {pins && pins.length > 0 && (
                <ul className="sites">
                  {pins.map((entry) => {
                    const label = documentLabel(entry.key);
                    const removing = busy?.kind === 'pin' && busy.key === entry.key;
                    return (
                      <li key={entry.key} className="site">
                        <span className="site-name" title={entry.key}>
                          {label}
                        </span>
                        <span className="pin-what">{describePin(entry.override)}</span>
                        <button
                          type="button"
                          className="btn btn-quiet btn-inline"
                          aria-label={`Unpin ${label}`}
                          disabled={locked}
                          onClick={() => unpin(entry.key)}
                        >
                          {removing ? 'Unpinning…' : 'Unpin'}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              {pins && pins.length > 0 && (
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={locked}
                    onClick={unpinAll}
                  >
                    {busy?.kind === 'pins' ? 'Unpinning…' : 'Unpin all'}
                  </button>
                </div>
              )}

              <Message notice={noticeFor('pins')} />
            </div>
          </section>

          {/* Backup ------------------------------------------------------- */}
          <section
            className="card"
            id="sec-backup"
            aria-labelledby="backup-h"
            tabIndex={-1}
          >
            <div className="card-head">
              <h2 id="backup-h">Backup</h2>
            </div>

            <div className="row row-stack">
              <h3 className="row-title">Save your settings to a file</h3>
              <p className="row-desc">
                A single JSON file holding every setting on this page, written
                straight to your downloads folder. It goes nowhere else — there is
                no account and no sync. Site permissions, scroll positions and
                pinned documents are not in it; the first is Chrome's to grant and
                the other two describe this computer rather than your preferences.
              </p>

              <div className="actions">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={locked}
                  onClick={handleExport}
                >
                  {busy?.kind === 'export' ? 'Saving…' : 'Export settings'}
                </button>
              </div>
            </div>

            <div className="row row-stack">
              <label className="row-title" htmlFor="settings-file">
                Load settings from a file
              </label>
              <p className="row-desc" id="settings-file-desc">
                Every field is checked against what this version understands before
                anything is written: values out of range are brought back into it,
                values of the wrong kind are left alone, and anything that is not a
                setting is ignored. A file this version cannot read changes nothing
                at all, and says why.
              </p>

              <input
                id="settings-file"
                className="file"
                type="file"
                accept="application/json,.json"
                aria-describedby="settings-file-desc"
                disabled={locked}
                onChange={(event) => void handleImport(event)}
              />

              <Message notice={noticeFor('backup')} />

              {imported?.ok && imported.notes.length > 0 && (
                <ul className="notes">
                  {imported.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Plugins ------------------------------------------------------ */}
          {/* Everything below is generated from `PLUGINS`, in the groups the
              contents lists them under, so nav order and page order are the
              same list read twice. There is no list of features here to fall
              out of step with the registry — a plugin that exists gets a
              section, and the controls in it are exactly the settings it
              declares, plus any global it owns. */}
          {PLUGIN_GROUPS.map((group) => (
            <div className="group" key={group.name}>
              <h2 className="group-head">{group.name}</h2>
              <p className="group-note">{group.note}</p>

              {group.plugins.map((plugin) => (
                <PluginSection
                  key={plugin.id}
                  plugin={plugin}
                  sectionId={pluginSectionId(plugin.id)}
                  stored={plugins}
                  failure={failures[plugin.id]}
                  owned={ownedPanels[plugin.id]}
                  onToggle={(enabled) =>
                    applyPlugins(withEnabled(plugins, plugin.id, enabled))
                  }
                  onSetting={(key, value, defer) =>
                    applyPlugins(withSetting(plugins, plugin.id, key, value), defer)
                  }
                />
              ))}
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}

export default App;
