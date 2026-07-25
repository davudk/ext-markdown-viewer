import { createRoot } from 'react-dom/client';
import { Viewer } from '@/components/Viewer';
import '@/components/viewer.css';

/**
 * Chrome gives extensions no way to register a content-type handler, so the only
 * way to render a .md file is to let Chrome paint it as plain text first, then
 * take the page over. We run at document_start to hide the raw text before it
 * flashes, then swap in the rendered view once parsing completes.
 */
export default defineContentScript({
  matches: [
    '*://*/*.md',
    '*://*/*.markdown',
    'file:///*.md',
    'file:///*.markdown',
  ],
  runAt: 'document_start',
  cssInjectionMode: 'manifest',

  main() {
    if (!looksLikePlainText()) return;

    const hide = hideRawText();

    onDomReady(() => {
      const source = readSource();

      // Not the single <pre> Chrome uses for plain text — some other page just
      // happens to end in .md. Leave it alone.
      if (source !== null) render(source);

      hide.remove();
    });
  },
});

/**
 * `document.contentType` is available at document_start and is the cheapest way
 * to skip real HTML pages whose URL happens to end in `.md`.
 */
function looksLikePlainText(): boolean {
  const type = document.contentType?.toLowerCase() ?? '';
  return type.startsWith('text/') && !type.includes('html');
}

function hideRawText(): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = ':root { visibility: hidden !important; }';
  document.documentElement.appendChild(style);
  return style;
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
  const pre = document.body?.querySelector('pre');
  if (!pre || document.body.children.length !== 1) return null;
  return pre.textContent ?? '';
}

function render(source: string) {
  document.body.replaceChildren();

  const host = document.createElement('div');
  host.id = 'mdv-root';
  document.body.appendChild(host);

  createRoot(host).render(<Viewer source={source} />);
}
