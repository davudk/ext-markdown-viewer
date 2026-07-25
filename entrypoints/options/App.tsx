import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
} from 'react';

// Straight from config rather than through settings.ts, which re-exports only
// the theme surface. These are static tables, not behaviour — see config.ts.
import {
  CUSTOM_CSS_MAX_LENGTH,
  DOCUMENT_STATE_LIMIT,
  DOCUMENT_THEME_LIMIT,
  CONTENT_WIDTH_CH,
  CONTENT_WIDTH_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_RANGE,
  FONT_STACKS,
  LINE_HEIGHT_RANGE,
  THEME_TOKENS,
  VIEWER_CSS_VARS,
} from '@/lib/config';
import { sendMessage, type SyncResult } from '@/lib/messages';
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
  PRESET_OPTIONS,
  resolvePolarity,
  sanitizeCustomCss,
  type DocumentTheme,
  type DocumentThemeEntry,
  type ThemePalette,
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
type Section =
  | 'rendering'
  | 'files'
  | 'sites'
  | 'appearance'
  | 'reading'
  | 'behaviour'
  | 'css'
  | 'pins'
  | 'backup';

/**
 * The typography settings this section owns. Named as a subset so the reset
 * button and the storage mirror both stay in step with it automatically —
 * `liveReload` and `rememberScroll` belong to another section and must not be
 * touched by anything here.
 */
type Reading = Pick<
  Settings,
  'fontFamily' | 'fontSize' | 'lineHeight' | 'contentWidth' | 'showToc'
>;

function pickReading(settings: Settings): Reading {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    contentWidth: settings.contentWidth,
    showToc: settings.showToc,
  };
}

const READING_DEFAULTS: Reading = pickReading(DEFAULT_SETTINGS);

/**
 * The two settings that change what the viewer *does* rather than how it looks.
 * Both are plain switches, so unlike the typography sliders there is nothing to
 * debounce — each flip is a single deliberate write.
 */
type Behaviour = Pick<Settings, 'liveReload' | 'rememberScroll'>;

function pickBehaviour(settings: Settings): Behaviour {
  return {
    liveReload: settings.liveReload,
    rememberScroll: settings.rememberScroll,
  };
}

const BEHAVIOUR_DEFAULTS: Behaviour = pickBehaviour(DEFAULT_SETTINGS);

/**
 * Every token of a palette as inline custom properties, so the preview below is
 * drawn by the same variables a real document is — not by a hand-built
 * approximation that could agree with the palette one week and not the next.
 */
function paletteVars(palette: ThemePalette): CSSProperties {
  const vars: Record<string, string> = {};
  for (const token of THEME_TOKENS) vars[`--mdv-${token}`] = palette[token];
  return vars as CSSProperties;
}

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

/** `1.65` on its own reads as nothing in a screen reader; this says what it is. */
function lineHeightText(value: number): string {
  return `${value.toFixed(2)} times the font size`;
}

/**
 * The step is 0.05, and repeated float addition drifts (1.7000000000000002),
 * which would leak into both the label and storage. Two decimals is the most
 * the range can express.
 */
function roundLineHeight(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The same four custom properties `Viewer.tsx` writes on the document shell.
 * Duplicated rather than shared because the two live in different bundles and
 * the mapping is one line each; VIEWER_CSS_VARS is the part that must not
 * drift, and that is imported.
 */
function previewVars(reading: Reading): CSSProperties {
  return {
    [VIEWER_CSS_VARS.fontFamily]: FONT_STACKS[reading.fontFamily],
    [VIEWER_CSS_VARS.fontSize]: `${reading.fontSize}px`,
    [VIEWER_CSS_VARS.lineHeight]: String(reading.lineHeight),
    [VIEWER_CSS_VARS.contentWidth]: CONTENT_WIDTH_CH[reading.contentWidth],
  } as CSSProperties;
}

type Notice = { tone: 'ok' | 'info' | 'error'; text: string };

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

/**
 * A labelled range with its value beside it.
 *
 * The `<output>` is what carries the value visually; `aria-valuetext` carries
 * it to a screen reader, because a range announces only the bare number and
 * "16" or "1.65" says nothing about what it is.
 */
function Slider({
  id,
  value,
  display,
  valueText,
  range,
  onChange,
}: {
  id: string;
  value: number;
  display: string;
  valueText: string;
  range: { min: number; max: number; step: number };
  onChange: (next: number) => void;
}) {
  return (
    <div className="slider">
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        aria-labelledby={`${id}-label`}
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {/* Hidden from the accessibility tree on purpose: `<output>` is a live
          region by default, so left exposed it would re-announce on every tick
          of a drag — on top of the range's own aria-valuetext, which already
          says the same thing. This copy is for eyes only. */}
      <output className="slider-value" htmlFor={id} aria-hidden="true">
        {display}
      </output>
    </div>
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
  const [behaviour, setBehaviour] = useState<Behaviour>(BEHAVIOUR_DEFAULTS);
  const [pins, setPins] = useState<DocumentThemeEntry[] | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [app] = useState(readManifest);

  /**
   * Which half of a preset the preview shows. `auto` has no colour of its own,
   * so the only honest preview is the one the reader would actually get, which
   * means asking the OS the same question the viewer asks it.
   */
  const [prefersDark, setPrefersDark] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * A write that has been decided but not yet made, and the timer that will
   * make it. Held in refs, not state: nothing on screen depends on them, and
   * re-rendering mid-drag for a bookkeeping change would be pure waste.
   */
  const queued = useRef<Partial<Settings> | null>(null);
  const writeTimer = useRef<number | null>(null);

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

  /**
   * Apply a reading setting. The screen updates synchronously in every case;
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

  /** Switches write immediately: a flip is one deliberate act, not a drag. */
  const applyBehaviour = useCallback(
    (patch: Partial<Behaviour>) => {
      setBehaviour((prev) => ({ ...prev, ...patch }));
      void saveSettings(patch).catch((error) =>
        say('behaviour', 'error', describeError(error)),
      );
    },
    [say],
  );

  const resetReading = () => {
    applyReading(READING_DEFAULTS);
    say('reading', 'ok', 'Reading settings are back to their defaults.');
  };

  // A queued write is lost if the page goes away first, and an options page is
  // usually closed the instant the last slider is released. `pagehide` is the
  // one event that still fires when the tab is closed or put in the bfcache.
  useEffect(() => {
    const onHide = () => flushWrite();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushWrite();
    };
  }, [flushWrite]);

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
    void loadSettings().then((settings) => {
      setTheme(settings.theme);
      setPreset(settings.themePreset);
      setCustomCss(settings.customCss);
      setReading(pickReading(settings));
      setBehaviour(pickBehaviour(settings));
    });
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

  const choosePreset = (next: ThemePresetId) => {
    setPreset(next);
    void saveSettings({ themePreset: next }).catch(() => undefined);
  };

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
      setBehaviour(pickBehaviour(settings));

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
  const palette = getPreset(preset)[polarity];

  /**
   * What would happen to the stylesheet if it were applied as typed. Recomputed
   * on every keystroke rather than on save, because the whole point is to say
   * what was dropped while there is still something to do about it.
   */
  const cssReport = useMemo(() => sanitizeCustomCss(customCss), [customCss]);
  const removedUrls = cssReport.removals.filter(
    (removal) => removal.kind === 'remote-url',
  ).length;
  const removedImports = cssReport.removals.filter(
    (removal) => removal.kind === 'import',
  ).length;
  const removedMarkup = cssReport.removals.filter(
    (removal) => removal.kind === 'markup',
  ).length;

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
                    onChange={() => chooseTheme(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="row row-stack">
            <div className="row-text">
              <h3 className="row-title" id="preset-label">
                Colour preset
              </h3>
              <div className="row-desc" id="preset-desc">
                <p>
                  Which palette rendered documents are drawn from. This is a
                  separate choice from <strong>Theme</strong> above and does not
                  override it: every preset comes in a light and a dark half, and
                  the setting above still decides which half you get — including{' '}
                  <strong>Auto</strong>, which keeps following your system.
                </p>
                <p>
                  Every preset meets the WCAG AA contrast minimum for body text,
                  muted text, links and syntax highlighting, measured against the
                  surface each one is actually painted on.{' '}
                  <strong>High contrast</strong> meets the stricter AAA level
                  throughout.
                </p>
              </div>
            </div>

            <div
              className="presets"
              role="radiogroup"
              aria-labelledby="preset-label"
              aria-describedby="preset-desc"
            >
              {PRESET_OPTIONS.map(({ value, label, note, swatch }) => (
                <label
                  key={value}
                  className={value === preset ? 'preset is-on' : 'preset'}
                >
                  <input
                    type="radio"
                    name="theme-preset"
                    value={value}
                    checked={value === preset}
                    onChange={() => choosePreset(value)}
                  />
                  <span className="preset-body">
                    {/* The half that is actually in use, so the chips are the
                        colours this reader would get rather than an average of
                        two palettes they will only ever see one of. */}
                    <span className="preset-swatch" aria-hidden="true">
                      {swatch[polarity].map((colour, index) => (
                        <span key={index} style={{ background: colour }} />
                      ))}
                    </span>
                    <span className="preset-text">
                      <span className="preset-name">{label}</span>
                      <span className="preset-note">{note}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="row row-stack">
            <h3 className="row-title" id="palette-label">
              Preview
            </h3>
            {/* Drawn from the preset's own custom properties, the same ones the
                viewer's stylesheet reads — so this is the palette itself, not a
                drawing of it that could drift. */}
            <div
              className="palette"
              style={paletteVars(palette)}
              role="group"
              aria-labelledby="palette-label"
            >
              <p className="palette-title">Notes on the estuary</p>
              <p className="palette-body">
                The tide runs out twice a day and leaves the whole channel bare.{' '}
                <a href="#preset-label">A link</a>, some{' '}
                <code className="palette-code">inline code</code>, and a line of{' '}
                <span className="palette-muted">quieter text beneath it</span>.
              </p>
              <pre className="palette-pre">
                <span className="tk-comment">// syntax colours are part of the preset</span>
                {'\n'}
                <span className="tk-keyword">export function</span>{' '}
                <span className="tk-title">tide</span>(
                <span className="tk-punct">hours</span>){' '}
                {'{'}
                {'\n  '}
                <span className="tk-keyword">return</span>{' '}
                <span className="tk-string">'ebb'</span>,{' '}
                <span className="tk-number">2</span>;{'\n'}
                {'}'}
              </pre>
            </div>
          </div>
        </section>

        {/* Your stylesheet ---------------------------------------------- */}
        <section className="card" aria-labelledby="css-h">
          <div className="card-head">
            <h2 id="css-h">Your stylesheet</h2>
          </div>

          <div className="row row-stack">
            <label className="row-title" htmlFor="custom-css">
              CSS applied to rendered documents
            </label>
            <div className="row-desc" id="custom-css-desc">
              <p>
                Applied on top of the theme, to the document itself and nothing
                else. Selectors are relative to the document body, so{' '}
                <code>h1</code> means a heading in the file — the viewer's own
                sidebar and toolbar, the popup and this page are all out of
                reach, by construction rather than by convention.
              </p>
              <p>
                Two things are removed before it is applied, and you are told
                when they are: <code>@import</code>, and any <code>url()</code>{' '}
                that is not a <code>data:</code> one. Both would make the viewer
                request something over the network, and it never requests
                anything.
              </p>
            </div>

            <textarea
              id="custom-css"
              className="editor"
              value={customCss}
              spellCheck={false}
              rows={8}
              maxLength={CUSTOM_CSS_MAX_LENGTH}
              aria-describedby="custom-css-desc custom-css-report"
              placeholder={'blockquote {\n  font-style: italic;\n}'}
              onChange={(event) => applyCustomCss(event.target.value)}
            />

            <p className="editor-count">
              {customCss.length.toLocaleString()} of{' '}
              {CUSTOM_CSS_MAX_LENGTH.toLocaleString()} characters
            </p>

            {/* Always in the DOM so a change is announced, and phrased as what
                happened rather than as a warning — the reader wrote this. */}
            <p
              id="custom-css-report"
              className={
                cssReport.error
                  ? 'msg is-err'
                  : cssReport.removals.length > 0 || cssReport.truncated
                    ? 'msg is-info'
                    : 'msg'
              }
              role="status"
              aria-live="polite"
            >
              {cssReport.error ??
                [
                  removedImports > 0 &&
                    `${removedImports} @import ${removedImports === 1 ? 'rule was' : 'rules were'} removed.`,
                  removedUrls > 0 &&
                    `${removedUrls} url() ${removedUrls === 1 ? 'reference was' : 'references were'} removed for pointing somewhere other than a data: URI.`,
                  removedMarkup > 0 && 'A `</` sequence was removed.',
                  cssReport.truncated && 'The text was cut at the size limit.',
                ]
                  .filter(Boolean)
                  .join(' ')}
            </p>

            <div className="actions">
              <button
                type="button"
                className="btn btn-quiet"
                disabled={customCss === ''}
                onClick={() => {
                  applyCustomCss('');
                  say('css', 'ok', 'Your stylesheet is empty again.');
                }}
              >
                Remove my stylesheet
              </button>
            </div>

            <Message notice={noticeFor('css')} />
          </div>
        </section>

        {/* Pinned documents --------------------------------------------- */}
        <section className="card" aria-labelledby="pins-h">
          <div className="card-head">
            <h2 id="pins-h">Pinned documents</h2>
          </div>

          <div className="row row-stack">
            <p className="row-desc">
              Documents you have given a theme of their own from the viewer.
              Each one ignores the settings above until it is unpinned. The last{' '}
              {DOCUMENT_THEME_LIMIT} are kept; beyond that the least recently
              opened is forgotten.
            </p>

            {pins === null && <Skeleton label="Loading pinned documents" />}

            {pins?.length === 0 && (
              <p className="empty">
                Nothing is pinned. Every document follows the theme and preset
                above.
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
        <section className="card" aria-labelledby="backup-h">
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
              ref={fileInput}
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

        {/* Reading ------------------------------------------------------ */}
        <section className="card" aria-labelledby="reading-h">
          <div className="card-head">
            <h2 id="reading-h">Reading</h2>
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="font-label">
                Font
              </h3>
              <p className="row-desc">
                Fonts already on this computer. The extension never downloads
                one, so nothing here reaches the network.
              </p>
            </div>

            <div
              className="segmented"
              role="radiogroup"
              aria-labelledby="font-label"
            >
              {FONT_FAMILY_OPTIONS.map(({ value, label }) => (
                <label
                  key={value}
                  className={
                    value === reading.fontFamily ? 'segment is-on' : 'segment'
                  }
                >
                  <input
                    type="radio"
                    name="font-family"
                    value={value}
                    checked={value === reading.fontFamily}
                    onChange={() =>
                      applyReading({ fontFamily: value })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="font-size-label">
                Font size
              </h3>
              <p className="row-desc">
                The base size for body text. Headings, code and captions are
                sized in proportion to it, so they all move together.
              </p>
            </div>

            <Slider
              id="font-size"
              value={reading.fontSize}
              display={`${reading.fontSize}px`}
              valueText={`${reading.fontSize} pixels`}
              range={FONT_SIZE_RANGE}
              // Deferred: a drag fires this on every pixel of travel.
              onChange={(next) => applyReading({ fontSize: next }, true)}
            />
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="line-height-label">
                Line height
              </h3>
              <p className="row-desc">
                Space between lines, as a multiple of the font size. More helps
                on long paragraphs; less fits more on screen.
              </p>
            </div>

            <Slider
              id="line-height"
              value={reading.lineHeight}
              display={reading.lineHeight.toFixed(2)}
              valueText={lineHeightText(reading.lineHeight)}
              range={LINE_HEIGHT_RANGE}
              onChange={(next) =>
                applyReading({ lineHeight: roundLineHeight(next) }, true)
              }
            />
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="content-width-label">
                Content width
              </h3>
              <p className="row-desc">
                How wide a line of text is allowed to get. Measured in
                characters rather than pixels, so it stays the same length of
                line whatever font size you pick. <strong>Full</strong> removes
                the limit.
              </p>
            </div>

            <div
              className="segmented"
              role="radiogroup"
              aria-labelledby="content-width-label"
            >
              {CONTENT_WIDTH_OPTIONS.map(({ value, label }) => (
                <label
                  key={value}
                  className={
                    value === reading.contentWidth ? 'segment is-on' : 'segment'
                  }
                >
                  <input
                    type="radio"
                    name="content-width"
                    value={value}
                    checked={value === reading.contentWidth}
                    onChange={() =>
                      applyReading({ contentWidth: value })
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="row">
            <div className="row-text">
              <h3 className="row-title" id="toc-label">
                Show table of contents
              </h3>
              <p className="row-desc" id="toc-desc">
                A sidebar of the document's headings, which follows along as you
                scroll. Documents with a single heading never show one, since an
                outline of one entry is not navigation.
              </p>
            </div>

            <Switch
              on={reading.showToc}
              busy={false}
              disabled={false}
              labelledBy="toc-label"
              describedBy="toc-desc"
              onChange={(next) => applyReading({ showToc: next })}
            />
          </div>

          <div className="row row-stack">
            <h3 className="row-title" id="preview-label">
              Preview
            </h3>
            {/* Rendered from the same four custom properties as a real
                document, so this is the actual result rather than an
                impression of it. */}
            <div
              className="preview"
              style={previewVars(reading)}
              role="group"
              aria-labelledby="preview-label"
            >
              <p className="preview-title">Notes on the estuary</p>
              <p>
                The tide runs out twice a day and leaves the whole channel bare,
                a flat grey mile of it, stitched with the tracks of birds that
                got there first.
              </p>
              <p>
                Everything worth reading is somewhere in the middle of a long
                paragraph, which is why a sample of one line tells you nothing
                about whether a setting is comfortable to read.
              </p>
            </div>

            <div className="actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={resetReading}
              >
                Reset to defaults
              </button>
            </div>

            <Message notice={noticeFor('reading')} />
          </div>
        </section>

        {/* Behaviour ---------------------------------------------------- */}
        <section className="card" aria-labelledby="behaviour-h">
          <div className="card-head">
            <h2 id="behaviour-h">Behaviour</h2>
          </div>

          <div className="row">
            <div className="row-main">
              <h3 className="row-title" id="scroll-label">
                Remember where you left off
              </h3>
              <p className="row-desc" id="scroll-desc">
                Reopening a document returns you to the section you were
                reading. Positions are stored locally and are kept for the last
                {' '}
                {DOCUMENT_STATE_LIMIT} documents.
              </p>
            </div>

            <Switch
              on={behaviour.rememberScroll}
              busy={false}
              disabled={false}
              labelledBy="scroll-label"
              describedBy="scroll-desc"
              onChange={(next) => applyBehaviour({ rememberScroll: next })}
            />
          </div>

          <div className="row">
            <div className="row-main">
              <h3 className="row-title" id="reload-label">
                Reload when the file changes
              </h3>
              {/* The copy states the network consequence plainly, because this
                  is the one setting that causes the extension to make a
                  request at all. */}
              <p className="row-desc" id="reload-desc">
                Re-reads the open document while you edit it, so saving shows
                the change without a refresh. This is the only setting that
                makes the extension send a request, and it only ever re-reads
                the document already on screen — never anything else, and never
                anywhere else. It is off unless you turn it on.
              </p>
            </div>

            <Switch
              on={behaviour.liveReload}
              busy={false}
              disabled={false}
              labelledBy="reload-label"
              describedBy="reload-desc"
              onChange={(next) => applyBehaviour({ liveReload: next })}
            />
          </div>

          <div className="row row-stack">
            <Message notice={noticeFor('behaviour')} />
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
