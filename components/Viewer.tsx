import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

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

  /**
   * The pipeline asks the host for its parser extensions. Without this the
   * viewer still renders and still sanitizes, but as bare CommonMark — a
   * visible symptom rather than a silent one.
   *
   * Installed during the *first render*, not from an effect. `doc` below is
   * memoized on the source, and the source does not change on mount: a host
   * installed after the first render would arrive one render too late and the
   * document would keep its bare-CommonMark HTML for the life of the page. The
   * frontmatter block is the visible tell — the card renders from the source,
   * while the block itself is still sitting in the body because the strip rule
   * was not installed when the body was parsed.
   */
  useState(() => setMarkdownHost(plugins));
  useEffect(() => {
    setMarkdownHost(plugins);
    return () => setMarkdownHost(null);
  }, [plugins]);

  /**
   * Bumps whenever a plugin is enabled or disabled. In the dependency list of
   * the parse below because enabling a *parser* plugin changes the HTML, and
   * the source has not changed — without this, toggling frontmatter or math off
   * in settings would rebuild the parser and then never use it.
   */
  const pluginRevision = useSyncExternalStore(
    plugins.status.subscribe,
    () => plugins.status.get(),
  );

  const doc = useMemo(() => renderMarkdown(source), [source, pluginRevision]);

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
        {/* Core regions: named for where they are, never for what fills them.

            `.mdv` is a flex *row* of exactly two tracks — the aside and
            everything else. Every other region lives inside `.mdv-main`, which
            stacks, so a contribution that sits in flow lands above or below the
            document rather than beside it. */}
        <Region name="shell.aside" />

        <div className="mdv-main">
          {/* The two top corners are laid out by the shell, because two
              plugins can want the same corner and only the shell can see both.
              The bottom corners are not: their occupants are full-width or
              self-positioned layers, and the plugins that fill them say so. */}
          <div className="mdv-corner mdv-corner-top-start" data-mdv-chrome>
            <Region name="chrome.top-start" />
          </div>
          <div className="mdv-corner mdv-corner-top-end" data-mdv-chrome>
            <Region name="chrome.top-end" />
            <RawToggle
              showRaw={showRaw}
              onToggle={() => setShowRaw((raw) => !raw)}
            />
          </div>

          {/* In flow, above the body and sharing its measure, so a card here
              reads as the top of the document rather than as a second column.
              Empty when nothing is contributed — see `.mdv-flow:empty`. */}
          <div className="mdv-flow">
            <Region name="document.before" />
          </div>

          <Document html={doc.html} source={source} showRaw={showRaw} />

          <div className="mdv-flow">
            <Region name="document.after" />
          </div>

          <Region name="chrome.bottom-start" />
          <Region name="chrome.bottom-end" />
        </div>

        <OverlayLayer />
      </div>
    </PluginProvider>
  );
}

/**
 * The raw/rendered switch.
 *
 * Shell chrome, not a plugin: the raw view is the fallback for everything the
 * viewer might get wrong, so it is the one control that must survive every
 * plugin being disabled. It carries no positioning of its own — the corner it
 * sits in is laid out by the shell.
 */
function RawToggle({
  showRaw,
  onToggle,
}: {
  showRaw: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="mdv-tool"
      aria-pressed={showRaw}
      aria-label={showRaw ? 'Show rendered document' : 'Show raw markdown'}
      onClick={onToggle}
    >
      <svg
        className="mdv-icon"
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {showRaw ? (
          <path d="M3 3.4h10M3 6.6h10M3 9.8h7M3 13h5" />
        ) : (
          <>
            <path d="M5.6 4.8 2.4 8l3.2 3.2" />
            <path d="M10.4 4.8 13.6 8l-3.2 3.2" />
          </>
        )}
      </svg>
      Raw
    </button>
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
