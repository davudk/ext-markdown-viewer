import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Viewer } from '@/components/Viewer';
import { VIEWER_ROOT_ID, VIEWER_THEME_DATASET_KEY } from '@/lib/config';
import { isCandidateUrl, isMarkdownContentType } from '@/lib/detect';
import {
  CORE_REGIONS,
  PLUGINS,
  PluginHost,
  SharedDocument,
  chromeStorage,
} from '@/lib/plugins';
import { loadSettings, onSettingsChanged, type Settings } from '@/lib/settings';
import {
  applyDocumentTheme,
  loadDocumentTheme,
  type DocumentTheme,
} from '@/lib/theme-presets';


/**
 * Chrome gives extensions no way to register a content-type handler, so the only
 * way to render a .md file is to let Chrome paint it as plain text first, then
 * take the page over.
 *
 * This is an unlisted script rather than a declared content script: the service
 * worker injects it with chrome.scripting, either registered at document_start
 * for origins the user has granted, or on demand via activeTab when they click
 * the toolbar button. Both paths land here, so nothing below may assume the
 * document is still loading.
 *
 * The stylesheet is injected separately by the service worker (see
 * `RENDERER_CSS` in lib/config.ts), so it is deliberately not imported here.
 */
export default defineUnlistedScript(() => {
  // Click-to-render on an already-rendered page, or a double registration, would
  // otherwise wipe the view and mount a second React root over it.
  if (document.getElementById(VIEWER_ROOT_ID)) return;

  if (!isCandidateUrl(location.href)) return;
  // `document.contentType` is available at document_start and is the cheapest
  // way to skip real HTML pages whose URL happens to end in `.md`.
  if (!isMarkdownContentType(document.contentType ?? '')) return;

  const reveal = hideRawText();

  onDomReady(async () => {
    const source = readSource();

    // Not the single <pre> Chrome uses for plain text — some other page just
    // happens to end in .md. Leave it alone.
    if (source === null || document.getElementById(VIEWER_ROOT_ID)) {
      reveal();
      return;
    }

    // Claim the page synchronously, before the first await. Two injections
    // racing at document_start would both clear the guard above otherwise,
    // and the loser would mount a second root over the winner's.
    const host = claimBody();

    try {
      // One read, used twice: the theme has to be on <html> before the reveal,
      // and the same settings seed the viewer so its first paint already has
      // the right typography rather than snapping to it a frame later.
      const settings = await loadSettings();
      // Resolved before the first paint, preset and custom CSS included:
      // applying them after mount would show the default palette for a frame.
      const override = await loadDocumentTheme(location.href);
      applyTheme(settings, override);

      // Started before the first render so an enabled plugin is already live
      // when the document appears, rather than flickering in a frame later.
      const documentHandle = new SharedDocument();
      const plugins = new PluginHost({
        plugins: PLUGINS,
        storage: chromeStorage(),
        document: documentHandle,
      });

      // The shell publishes the regions that follow from its own layout, before
      // anything can contribute to them — a contribution to a region nobody has
      // declared is inert, which is correct for a disabled sidebar and wrong
      // for a corner the shell renders unconditionally.
      for (const region of CORE_REGIONS) plugins.regions.declare(region);

      await plugins.start();

      // React 19 commits asynchronously by default; flushSync makes the markup
      // exist before `reveal()` runs, so there is no blank frame between the
      // raw text disappearing and the rendered view appearing.
      flushSync(() =>
        createRoot(host).render(
          <Viewer
            source={source}
            initialSettings={settings}
            plugins={plugins}
            documentHandle={documentHandle}
          />,
        ),
      );
    } catch (error) {
      // Chrome's <pre> is already gone, so failing here without a fallback
      // would hand the reader a blank page — strictly worse than the raw text
      // they would have seen if the extension had never run. Put it back.
      console.error('[markdown-viewer] render failed:', error);
      restoreRawText(source);
    } finally {
      // Whatever happened above, the page must not stay invisible. On the
      // post-load injection path there is nothing to hide anyway.
      reveal();
    }
  });
});

function hideRawText(): () => void {
  const style = document.createElement('style');
  style.textContent = ':root { visibility: hidden !important; }';
  document.documentElement.appendChild(style);
  return () => style.remove();
}

function onDomReady(fn: () => void) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

/**
 * Chrome wraps plain-text documents in a single <pre>. Returns null when the
 * body isn't that shape, which means we're not looking at a text file.
 */
function readSource(): string | null {
  const body = document.body;
  if (!body || body.children.length !== 1) return null;

  const pre = body.firstElementChild;
  if (!(pre instanceof HTMLPreElement)) return null;

  return pre.textContent ?? '';
}

/** Replaces Chrome's <pre> with the React host and returns it. */
function claimBody(): HTMLDivElement {
  const host = document.createElement('div');
  host.id = VIEWER_ROOT_ID;
  document.body.replaceChildren(host);
  return host;
}

/** Last resort after a failed render: reinstate something the reader can read. */
function restoreRawText(source: string): void {
  const pre = document.createElement('pre');
  pre.textContent = source;
  document.body.replaceChildren(pre);
}

/**
 * Resolves the theme — polarity, preset palette and custom CSS — onto the
 * document, and keeps it current for the document's lifetime.
 *
 * This is the only writer of `data-mdv-theme` for the page's own document.
 * `Viewer` re-applies it when the reader opens a different file through the
 * Files tab, since a per-document pin is keyed by URL and that changes.
 */
function applyTheme(initial: Settings, override: DocumentTheme | null) {
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let settings = initial;

  const paint = () => {
    applyDocumentTheme(document, {
      settings,
      override,
      prefersDark: darkQuery.matches,
    });
  };

  onSettingsChanged((next) => {
    settings = next;
    paint();
  });

  // Only observable while the theme is 'auto', but subscribing unconditionally
  // avoids having to add and remove the listener as the setting changes.
  darkQuery.addEventListener('change', paint);

  paint();
}
