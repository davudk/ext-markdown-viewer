import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import {
  CONTENT_WIDTH_CH,
  FONT_STACKS,
  THEME_OPTIONS,
  VIEWER_CSS_VARS,
} from '@/lib/config';
import { useKeyboardShortcuts, useLiveReload, useScrollMemory } from '@/lib/hooks';
import { renderMarkdown } from '@/lib/markdown';
import { onSettingsChanged, saveSettings, type Settings } from '@/lib/settings';

import { Document } from './Document';
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

  const source = opened?.source ?? pageSource;
  const url = opened?.url ?? location.href;

  // Reparsing on a settings change would stall a large document every time the
  // font size is nudged; typography is applied through CSS variables instead.
  const doc = useMemo(() => renderMarkdown(source), [source]);

  useEffect(() => onSettingsChanged(setSettings), []);

  // A single heading is an outline of one — noise rather than navigation.
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
      <Lightbox enabled={settings.lightbox && !showRaw} />
      <HeadingFold html={doc.html} enabled={settings.headingFold && !showRaw} />
      <ReadingStatus
        html={doc.html}
        stats={settings.readingStats && !showRaw}
        progress={settings.readingProgress && !showRaw}
      />
      <Presentation
        html={doc.html}
        split={settings.slideSplit}
        enabled={settings.presentation && !showRaw}
      />
    </div>
  );
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
