/**
 * Shared setup for the markdown pipeline tests.
 *
 * Two things every one of them needs:
 *
 *  - **jsdom, before `lib/markdown.ts` is imported.** DOMPurify binds to
 *    whatever `window` exists at import time and, when `document.implementation`
 *    is missing, sets `isSupported = false` and returns its input *unchanged*.
 *    Under a lighter DOM shim every XSS assertion in this suite would pass while
 *    the payloads sailed straight through.
 *
 *  - **A host.** Syntax is a plugin now, so a parser with no host applied
 *    renders CommonMark and nothing else. `markdownHost` is the smallest thing
 *    satisfying `MarkdownItHost`: it sorts by the real `sortPlugins` — the same
 *    function `PluginHost` uses — and applies whatever it is given. Sorting with
 *    the production implementation is the point, because it is what makes
 *    `order-independence.test.ts` a test of the `after:` declarations rather
 *    than of a stub.
 */

import { JSDOM } from 'jsdom';

import { sortPlugins } from '../lib/plugins/host.ts';
import type { AnyPlugin, Logger, PluginContext } from '../lib/plugins/types.ts';

import { markdownContainersPlugin } from '../plugins/markdown-containers/index.ts';
// Assembled here rather than imported: the plugin's `index.tsx` names a React
// component, and `--experimental-strip-types` refuses a `.tsx`. What this file
// needs is the parser half, which `plugin.ts` gives it whole.
import { createFrontmatterPlugin } from '../plugins/frontmatter/plugin.ts';
import { markdownEmojiPlugin } from '../plugins/markdown-emoji/index.ts';
import { markdownFootnotesPlugin } from '../plugins/markdown-footnotes/index.ts';
import { markdownGithubAlertsPlugin } from '../plugins/markdown-github-alerts/index.ts';
import { markdownHeadingsPlugin } from '../plugins/markdown-headings/index.ts';
import { markdownMathPlugin } from '../plugins/markdown-math/index.ts';
import { markdownMermaidPlugin } from '../plugins/markdown-mermaid/index.ts';
import { markdownTablesPlugin } from '../plugins/markdown-tables/index.ts';
import { markdownWikilinksPlugin } from '../plugins/markdown-wikilinks/index.ts';

export const frontmatterPlugin = createFrontmatterPlugin(() => null);

/** The registry order, mirrored. Kept in one place so the tests cannot drift. */
export const MARKDOWN_PLUGINS: readonly AnyPlugin[] = [
  frontmatterPlugin,
  markdownFootnotesPlugin,
  markdownEmojiPlugin,
  markdownTablesPlugin,
  markdownGithubAlertsPlugin,
  markdownContainersPlugin,
  markdownMathPlugin,
  markdownMermaidPlugin,
  markdownWikilinksPlugin,
  markdownHeadingsPlugin,
];

const quiet: Logger = { warn: () => {}, error: () => {} };

/** Everything but the named plugins — how "disabled" is expressed in a test. */
export function without(...ids: string[]): AnyPlugin[] {
  return MARKDOWN_PLUGINS.filter((plugin) => !ids.includes(plugin.id));
}

/**
 * A `MarkdownItHost` over a fixed plugin set.
 *
 * No `PluginContext` is built: none of these plugins reads one, and a stub
 * standing in for the real context would be a second, wrong definition of it.
 * If one ever does need settings, this is where a real host belongs instead.
 */
export function markdownHost(plugins: readonly AnyPlugin[] = MARKDOWN_PLUGINS) {
  const sorted = sortPlugins(plugins, quiet);
  return {
    applyMarkdownIt(md: never) {
      for (const plugin of sorted) plugin.markdownIt?.(md, {} as PluginContext);
    },
  };
}

/** Installs the DOM globals DOMPurify needs, before `lib/markdown.ts` loads. */
export function installDom(url = 'https://example.test/'): JSDOM {
  const dom = new JSDOM('', { url });
  // Assigned through a loose view of globalThis: these are DOM globals that
  // node's type definitions do not declare, and the alternative is seven casts.
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    'window',
    'document',
    'Node',
    'DocumentFragment',
    'HTMLTemplateElement',
    'NodeFilter',
    'trustedTypes',
  ]) {
    globals[name] =
      name === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[name];
  }
  return dom;
}

/**
 * jsdom + the markdown module + a host, in the order those three require.
 *
 * Returns `use`, which swaps the plugin set for the next `renderMarkdown` call —
 * the parser is rebuilt on the next parse, so a test can render the same source
 * with a plugin on and off and compare.
 */
export async function loadPipeline(plugins: readonly AnyPlugin[] = MARKDOWN_PLUGINS) {
  installDom();
  const markdown = await import('../lib/markdown.ts');
  markdown.setMarkdownHost(markdownHost(plugins) as never);

  return {
    render: (source: string) => markdown.renderMarkdown(source),
    use(next: readonly AnyPlugin[]) {
      markdown.setMarkdownHost(markdownHost(next) as never);
    },
  };
}
