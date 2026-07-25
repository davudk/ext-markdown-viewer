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
import { applyDocumentTheme, loadDocumentTheme } from '@/lib/theme-presets';

import { CommandPalette } from './CommandPalette';
import { Diff } from './Diff';
import { Document } from './Document';
import { ExportMenu } from './ExportMenu';
import type { OpenedDocument } from './FolderBrowser';
import { HeadingFold } from './HeadingFold';
import { Lightbox } from './Lightbox';
import { Presentation } from './Presentation';
import { ReadingStatus } from './ReadingStatus';
import { Search } from './Search';
import { Sidebar } from './Sidebar';

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
}: {
  source: string;
  initialSettings: Settings;
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

  // Deliberately not gated on heading count any more: the sidebar also holds
  // the Files tab, which is worth reaching from a document with no outline.
  const hasSidebar = settings.showToc && !showRaw;

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
    toggleToc: () => void saveSettings({ showToc: !settings.showToc }),
    toggleRaw: () => setShowRaw((raw) => !raw),
    cycleTheme: () => void saveSettings({ theme: nextTheme(settings.theme) }),
  });

  return (
    <div
      className={hasSidebar ? 'mdv mdv-with-toc' : 'mdv'}
      style={typographyVars(settings)}
    >
      {hasSidebar ? (
        <Sidebar
          headings={doc.headings}
          documentUrl={url}
          source={source}
          onOpenDocument={setOpened}
          onCompare={setCompare}
        />
      ) : null}

      <Document
        html={doc.html}
        source={source}
        showRaw={showRaw}
        externalLinks={settings.externalLinks}
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

      <Presentation
        html={doc.html}
        split={settings.slideSplit}
        enabled={settings.presentation && !showRaw}
      />
    </div>
  );
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
