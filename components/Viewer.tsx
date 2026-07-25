import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  CONTENT_WIDTH_CH,
  FONT_STACKS,
  THEME_OPTIONS,
  VIEWER_CSS_VARS,
} from '@/lib/config';
import { useKeyboardShortcuts, useLiveReload, useScrollMemory } from '@/lib/hooks';
import type { CompareRequest } from '@/lib/diff';
import { renderMarkdown } from '@/lib/markdown';
import { onSettingsChanged, saveSettings, type Settings } from '@/lib/settings';
import {
  OverlayLayer,
  PluginProvider,
  Region,
  type PluginHost,
  type SharedDocument,
} from '@/lib/plugins';
import { applyDocumentTheme, loadDocumentTheme } from '@/lib/theme-presets';

import { CommandPalette } from './CommandPalette';
import { Diff } from './Diff';
import { Document } from './Document';
import { ExportMenu } from './ExportMenu';
import { HeadingFold } from './HeadingFold';
import { Lightbox } from './Lightbox';
import { ReadingStatus } from './ReadingStatus';
import { Search } from './Search';

import type { OpenedDocument } from '@/plugins/files/types';

/**
 * The regions the shell publishes, because each follows from its own layout
 * rather than from a feature.
 *
 * `shell.aside` is the leading flex track: `entrypoints/viewer.css` gives
 * `.mdv-with-toc > nav` its width, stickiness and its stacking behaviour below
 * 60rem, so whatever renders here is a column beside the document. It is named
 * for where it is, never for what fills it — the sidebar is one plugin that
 * happens to want a column.
 *
 * Nothing declared these before: `CORE_REGIONS` in lib/plugins/types.ts is a
 * list, and the host only declares what a plugin `provides`. Until a plugin
 * contributed UI, every core region was quietly inert.
 */
const SHELL_REGIONS = [
  'shell.aside',
  'chrome.top-start',
  'chrome.top-end',
  'chrome.bottom-start',
  'chrome.bottom-end',
  'document.before',
  'document.after',
] as const;

/**
 * The viewer shell: layout, settings plumbing, and the state features share.
 *
 * The document is parsed once here and the result passed down, so the outline
 * the table of contents renders and the ids the document body carries come out
 * of the same pass. Everything else — copy buttons, anchor links, scroll-spy —
 * lives in the component that owns it.
 *
 * Settings arrive already loaded so the first paint is correct; later changes
 * come through the storage subscription.
 */
export function Viewer({
  source: initialSource,
  initialSettings,
  plugins,
  documentHandle,
}: {
  source: string;
  initialSettings: Settings;
  plugins: PluginHost;
  documentHandle: SharedDocument;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [showRaw, setShowRaw] = useState(false);

  /**
   * The document on screen. Normally the page's own file, but the Files tab can
   * hand us one read through a directory handle — which has no page URL of its
   * own. Everything URL-keyed (scroll memory, live reload, link resolution)
   * reads `url` from here rather than `location`, so those features describe the
   * document actually being displayed instead of the one the tab was opened on.
   */
  const [opened, setOpened] = useState<OpenedDocument | null>(null);

  /** The page's own document, kept in state so live reload can replace it. */
  const [pageSource, setPageSource] = useState(initialSource);

  /** Both phases of compare — the row menu and the overlay — hang off this. */
  const [compare, setCompare] = useState<CompareRequest | null>(null);

  const source = opened?.source ?? pageSource;
  const url = opened?.url ?? location.href;

  // Reparsing on a settings change would stall a large document every time the
  // font size is nudged; typography is applied through CSS variables instead.
  const doc = useMemo(() => renderMarkdown(source), [source]);

  useEffect(() => onSettingsChanged(setSettings), []);

  /**
   * Re-resolve the theme when the document changes.
   *
   * The renderer already applied it before first paint, and re-applies on every
   * settings change — but a per-document pin is keyed by URL, and opening a file
   * through the Files tab changes the URL without reloading the page. Skipped
   * for the page's own document so this never duplicates the renderer's work.
   */
  useEffect(() => {
    if (opened === null) return;

    let cancelled = false;
    void loadDocumentTheme(opened.url).then((override) => {
      if (cancelled) return;
      applyDocumentTheme(document, {
        settings,
        override,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [opened, settings]);

  /**
   * Publish the shell's view of the document to the plugin host.
   *
   * Runs after paint so `.mdv-body` exists — plugins read the live element, not
   * a string, and a pass scheduled against a body that has not rendered would
   * find nothing.
   */
  useEffect(() => {
    documentHandle.update({
      body: window.document.querySelector<HTMLElement>('main.mdv-body'),
      source,
      html: doc.html,
      headings: doc.headings,
      url,
      isRaw: showRaw,
    });
  }, [documentHandle, doc, source, url, showRaw]);

  useShellRegions(plugins);

  /**
   * What the shell can do, offered to plugins as capabilities.
   *
   * The Files tab opens a document read through a directory handle, and asks
   * for two files to be compared; both are shell state. The shell is not a
   * plugin and has no `PluginContext`, so it publishes onto the host's store
   * directly — a plugin `use`s them like any other capability, and finds them
   * absent while this has not mounted, which is a state it already handles.
   */
  useEffect(() => {
    const withdraw = [
      plugins.capabilities.provide('document.open', (document: OpenedDocument) =>
        setOpened(document),
      ),
      plugins.capabilities.provide('document.compare', (request: CompareRequest) =>
        setCompare(request),
      ),
    ];
    return () => withdraw.forEach((stop) => stop());
  }, [plugins]);

  useScrollMemory({
    url,
    enabled: settings.rememberScroll,
    // The raw view has none of the headings positions are measured against, so
    // restoring into it would land nowhere meaningful.
    ready: !showRaw,
  });

  useLiveReload({
    // Always the page's own address — the hook refuses anything else by design.
    // A file opened through a directory handle has no fetchable URL, so polling
    // is switched off rather than pointed somewhere it cannot go.
    url: location.href,
    enabled: settings.liveReload && opened === null,
    source: pageSource,
    onChange: setPageSource,
  });

  useKeyboardShortcuts({
    // Whether the sidebar exists is the sidebar plugin's enabled state and
    // nothing else. The `showToc` setting it replaces is no longer read here.
    toggleToc: () => void plugins.setEnabled('sidebar', !plugins.isEnabled('sidebar')),
    toggleRaw: () => setShowRaw((raw) => !raw),
    cycleTheme: () => void saveSettings({ theme: nextTheme(settings.theme) }),
  });

  return (
    <PluginProvider host={plugins}>
      {/* `mdv-with-toc` is added by whatever fills `shell.aside`: only the
          column itself knows whether it is there. */}
      <div className="mdv" style={typographyVars(settings)}>
        {/* Core regions: named for where they are, never for what fills them. */}
        <Region name="shell.aside" />
        <Region name="chrome.top-start" />
        <Region name="chrome.top-end" />
        <Region name="document.before" />

      <Document
        html={doc.html}
        source={source}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw((raw) => !raw)}
      />

      {/* Overlays and passes over the rendered body, not flex children: each is
          fixed-position or portalled, so none of them becomes a second column.
          They take `html` as a staleness signal and read the live body. */}
      {showRaw ? null : <Search headings={doc.headings} />}
      {/* Safe to mount unconditionally: it imports the export machinery with
          `import type` only and asks the service worker to inject the add-on on
          first use, so nothing here costs a plain README any bytes. */}
      {showRaw ? null : (
        <ExportMenu
          url={url}
          typography={{
            fontFamily: settings.fontFamily,
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight,
            contentWidth: settings.contentWidth,
          }}
        />
      )}
      <Lightbox enabled={settings.lightbox && !showRaw} />
      <HeadingFold html={doc.html} enabled={settings.headingFold && !showRaw} />
      <ReadingStatus
        html={doc.html}
        stats={settings.readingStats && !showRaw}
        progress={settings.readingProgress && !showRaw}
      />
      {/* Not gated on `showRaw`: the palette is how a reader gets back out of
          the raw view. Export and compare rows are absent until the shell can
          supply their handlers — the palette drops a row rather than listing an
          action that would do nothing. */}
      <CommandPalette
        headings={doc.headings}
        settings={settings}
        documentUrl={url}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw((raw) => !raw)}
      />

      <Diff
        request={compare}
        currentName={opened?.name ?? documentName(url)}
        currentSource={source}
        onClose={() => setCompare(null)}
      />

        <Region name="document.after" />
        <Region name="chrome.bottom-start" />
        <Region name="chrome.bottom-end" />
        <OverlayLayer />
      </div>
    </PluginProvider>
  );
}

/**
 * Publishes the shell's regions for the life of the shell.
 *
 * Declared during the first render rather than from an effect: `<Region>` reads
 * the registry as it renders, so declaring afterwards would cost a second pass
 * and one frame with no sidebar in it.
 */
function useShellRegions(host: PluginHost): void {
  const [withdraw] = useState(() =>
    SHELL_REGIONS.map((region) => host.regions.declare(region)),
  );
  useEffect(() => () => withdraw.forEach((stop) => stop()), [withdraw]);
}

/** Last path segment, for naming the document on screen in the diff header. */
function documentName(rawUrl: string): string {
  try {
    const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
    return decodeURIComponent(segments[segments.length - 1] ?? '') || 'this document';
  } catch {
    return 'this document';
  }
}

/** Steps through the theme options in the order the settings page presents them. */
function nextTheme(current: Settings['theme']): Settings['theme'] {
  const index = THEME_OPTIONS.findIndex((option) => option.value === current);
  return THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length].value;
}

/**
 * Typography as inline custom properties on the shell. Keeping it in CSS means
 * a change repaints without React touching the document body at all.
 */
function typographyVars(settings: Settings): CSSProperties {
  return {
    [VIEWER_CSS_VARS.fontFamily]: FONT_STACKS[settings.fontFamily],
    [VIEWER_CSS_VARS.fontSize]: `${settings.fontSize}px`,
    [VIEWER_CSS_VARS.lineHeight]: String(settings.lineHeight),
    [VIEWER_CSS_VARS.contentWidth]: CONTENT_WIDTH_CH[settings.contentWidth],
  } as CSSProperties;
}
