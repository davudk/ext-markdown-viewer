import { useEffect, useMemo, useState } from 'react';

import { useKeyboardShortcuts } from '@/lib/hooks';
import { renderMarkdown, setMarkdownHost } from '@/lib/markdown';
import {
  OverlayLayer,
  PluginProvider,
  Region,
  type PluginHost,
  type SharedDocument,
} from '@/lib/plugins';

import { Document } from './Document';

import type { OpenedDocument } from '@/plugins/files/types';

/**
 * The viewer shell.
 *
 * What is left here is only what no feature owns: the document's identity and
 * revision, the raw toggle, and the regions plugins render into. Everything a
 * reader would recognise as a feature — the sidebar, search, export, the
 * lightbox, theming, typography — is a plugin, and the shell does not know any
 * of their names.
 *
 * The document is parsed once and published to the host, so the outline, the
 * ids in the body and the text every plugin reads come out of one pass.
 */
export function Viewer({
  source: initialSource,
  plugins,
  documentHandle,
}: {
  source: string;
  plugins: PluginHost;
  documentHandle: SharedDocument;
}) {
  const [showRaw, setShowRaw] = useState(false);

  /**
   * The document on screen. Normally the page's own file, but the Files tab can
   * hand us one read through a directory handle — which has no page URL of its
   * own. Everything URL-keyed reads from here rather than `location`, so those
   * features describe the document being displayed and not the one the tab was
   * opened on.
   */
  const [opened, setOpened] = useState<OpenedDocument | null>(null);

  /** The page's own document, kept in state so live reload can replace it. */
  const [pageSource, setPageSource] = useState(initialSource);

  const source = opened?.source ?? pageSource;
  const url = opened?.url ?? location.href;

  const doc = useMemo(() => renderMarkdown(source), [source]);

  // The pipeline asks the host for its parser extensions. Without this the
  // viewer still renders and still sanitizes, but as bare CommonMark — a
  // visible symptom rather than a silent one.
  useEffect(() => setMarkdownHost(plugins), [plugins]);

  useShellRegions(plugins);

  /**
   * Publish the shell's view of the document to the host.
   *
   * After paint, so `.mdv-body` exists: plugins read the live element, and a
   * pass scheduled against a body that has not rendered would find nothing.
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

  /**
   * What the shell can do, offered to plugins as capabilities.
   *
   * These three are shell state, not any plugin's: which document is displayed,
   * which revision of it, and whether the raw view is showing. The shell is not
   * a plugin and has no `PluginContext`, so it publishes onto the host's store
   * directly — a plugin `use`s them like any other, and finds them absent before
   * this has mounted, which is a state it already handles.
   */
  useEffect(() => {
    const withdraw = [
      plugins.capabilities.provide('document.open', setOpened),
      plugins.capabilities.provide('document.reload', setPageSource),
      plugins.capabilities.provide('document.toggleRaw', () =>
        setShowRaw((raw) => !raw),
      ),
    ];
    return () => withdraw.forEach((stop) => stop());
  }, [plugins]);

  useKeyboardShortcuts({
    // Whether the sidebar exists is the sidebar plugin's enabled state and
    // nothing else.
    toggleToc: () => void plugins.setEnabled('sidebar', !plugins.isEnabled('sidebar')),
    toggleRaw: () => setShowRaw((raw) => !raw),
  });

  return (
    <PluginProvider host={plugins}>
      {/* `mdv-with-toc` is added by whatever fills `shell.aside`: only the
          column itself knows whether it is there. */}
      <div className="mdv">
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
 * and one frame with nothing in any region. The host declares the same set at
 * startup; declarations are counted, so both claims coexist.
 */
function useShellRegions(host: PluginHost): void {
  const [withdraw] = useState(() =>
    (
      [
        'shell.aside',
        'chrome.top-start',
        'chrome.top-end',
        'chrome.bottom-start',
        'chrome.bottom-end',
        'document.before',
        'document.after',
      ] as const
    ).map((region) => host.regions.declare(region)),
  );
  useEffect(() => () => withdraw.forEach((stop) => stop()), [withdraw]);
}
