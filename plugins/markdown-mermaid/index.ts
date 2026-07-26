/**
 * Keeps a ```mermaid fence out of the highlighter's hands.
 *
 * `entrypoints/mermaid-addon.ts` reads the block's text back out of the DOM and
 * feeds it to a parser, so the diagram has to survive as characters. highlight.js
 * has no mermaid grammar in the bundled "common" set and the generic path would
 * already escape it — which is exactly why this is explicit rather than
 * incidental: registering a mermaid grammar later, or moving to the full hljs
 * build, would otherwise quietly shred every diagram into token spans. Its test
 * registers one to prove the difference is real.
 *
 * The shape is a wrapper, not a replacement: it takes whatever `highlight`
 * option the parser was built with and delegates everything that is not a
 * mermaid fence, so this plugin owns exactly one decision — *do not touch this
 * one* — and `lib/markdown.ts` still renders every other block.
 *
 * The `<pre>` it emits for its own block is built from the same
 * `HIGHLIGHT_LANG_PREFIX` as the generic path, because that class is the
 * contract three other things read (`viewer.css`, the exported stylesheet, and
 * the add-on's own `language-mermaid` selector). Spelling it out here rather
 * than borrowing a helper from `lib/markdown.ts` is what keeps the dependency
 * pointing at `config.ts` — where the contract is already documented — instead
 * of at the module that loads this one.
 *
 * Because it wraps, it must be applied after the parser is constructed, which
 * `applyMarkdownIt` guarantees. It composes with any other wrapper regardless
 * of load order: each one delegates down to the one beneath it.
 */

import type MarkdownIt from 'markdown-it';

import { HIGHLIGHT_LANG_PREFIX, MERMAID_LANGUAGE } from '../../lib/config.ts';
import { escapeHtml } from '../../lib/escape.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const markdownMermaidPlugin: Plugin = {
  id: 'markdown-mermaid-fence',
  name: 'Mermaid fences',
  description: 'Passes ```mermaid blocks through unhighlighted, for the diagram add-on.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    const inner = md.options.highlight;

    md.set({
      highlight: (code, info, attrs) => {
        if (info.trim() === MERMAID_LANGUAGE) {
          // The whole `<pre>`: markdown-it takes a `<pre`-prefixed return
          // verbatim, which is the only way to control the class on a block it
          // would otherwise label with its own `langPrefix`.
          const className = `${HIGHLIGHT_LANG_PREFIX}${MERMAID_LANGUAGE}`;
          return `<pre><code class="${className}">${escapeHtml(code)}</code></pre>`;
        }
        // `?? ''` rather than a throw: a parser built with no highlighter is a
        // legitimate configuration, and markdown-it reads an empty string as
        // "escape it yourself", which is the correct fallback anyway.
        return inner?.(code, info, attrs) ?? '';
      },
    });
  },
};
