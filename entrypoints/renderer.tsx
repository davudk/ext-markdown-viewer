import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Viewer } from '@/components/Viewer';
import { isCandidateUrl, isMarkdownContentType } from '@/lib/detect';
import { loadSettings, onSettingsChanged, type Theme } from '@/lib/settings';

const ROOT_ID = 'mdv-root';

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
 * `RENDERER_CSS` in lib/messages.ts), so it is deliberately not imported here.
 */
export default defineUnlistedScript(() => {
  // Click-to-render on an already-rendered page, or a double registration, would
  // otherwise wipe the view and mount a second React root over it.
  if (document.getElementById(ROOT_ID)) return;

  if (!isCandidateUrl(location.href)) return;
  // `document.contentType` is available at document_start and is the cheapest
  // way to skip real HTML pages whose URL happens to end in `.md`.
  if (!isMarkdownContentType(document.contentType ?? '')) return;

  const reveal = hideRawText();

  onDomReady(async () => {
    try {
      const source = readSource();

      // Not the single <pre> Chrome uses for plain text — some other page just
      // happens to end in .md. Leave it alone.
      if (source === null) return;
      if (document.getElementById(ROOT_ID)) return;

      // Resolving the theme is async, and it has to win the race against the
      // first paint: revealing before the attribute is set would flash the
      // light palette on a dark document.
      await applyTheme();

      mount(source);
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

function mount(source: string) {
  document.body.replaceChildren();

  const host = document.createElement('div');
  host.id = ROOT_ID;
  document.body.appendChild(host);

  // React 19 commits asynchronously by default; flushSync makes the markup exist
  // before the caller un-hides the page, so there is no blank frame between the
  // raw text disappearing and the rendered view appearing.
  flushSync(() => createRoot(host).render(<Viewer source={source} />));
}

/**
 * Reflects the effective theme onto <html> as `data-mdv-theme`, which is what
 * viewer.css keys off, and keeps it current for the life of the document.
 */
async function applyTheme() {
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let theme: Theme = (await loadSettings()).theme;

  const paint = () => {
    document.documentElement.dataset.mdvTheme =
      theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme;
  };

  onSettingsChanged((settings) => {
    theme = settings.theme;
    paint();
  });

  // Only observable while `theme` is 'auto', but subscribing unconditionally
  // avoids having to add and remove the listener as the setting changes.
  darkQuery.addEventListener('change', paint);

  paint();
}
