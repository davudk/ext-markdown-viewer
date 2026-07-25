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
import { Lightbox } from './Lightbox';
import { Search } from './Search';
import { Toc } from './Toc';

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
  const [source, setSource] = useState(initialSource);
  const [showRaw, setShowRaw] = useState(false);

  // Reparsing on a settings change would stall a large document every time the
  // font size is nudged; typography is applied through CSS variables instead.
  const doc = useMemo(() => renderMarkdown(source), [source]);

  useEffect(() => onSettingsChanged(setSettings), []);

  // A single heading is an outline of one — noise rather than navigation.
  const hasToc = settings.showToc && doc.headings.length > 1 && !showRaw;

  useScrollMemory({
    url: location.href,
    enabled: settings.rememberScroll,
    // The raw view has none of the headings positions are measured against, so
    // restoring into it would land nowhere meaningful.
    ready: !showRaw,
  });

  useLiveReload({
    url: location.href,
    enabled: settings.liveReload,
    source,
    onChange: setSource,
  });

  useKeyboardShortcuts({
    toggleToc: () => void saveSettings({ showToc: !settings.showToc }),
    toggleRaw: () => setShowRaw((raw) => !raw),
    cycleTheme: () => void saveSettings({ theme: nextTheme(settings.theme) }),
  });

  return (
    <div
      className={hasToc ? 'mdv mdv-with-toc' : 'mdv'}
      style={typographyVars(settings)}
    >
      {hasToc ? <Toc headings={doc.headings} /> : null}

      <Document
        html={doc.html}
        source={source}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw((raw) => !raw)}
      />

      {/* Both are position-fixed overlays rather than flex children, so they sit
          outside the document track and cannot become a second column. Search is
          pointless over raw source, which has no headings to group results by. */}
      {showRaw ? null : <Search headings={doc.headings} />}
      <Lightbox enabled={settings.lightbox && !showRaw} />
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
