/**
 * Heading ids, and the outline built from them.
 *
 * These are one plugin and not two because the outline is defined by the ids:
 * the table of contents, the anchor links and the document body all have to
 * agree on the same slugs, and deriving the outline by re-scanning the rendered
 * HTML afterwards would work until a heading contained markup, at which point
 * the two would disagree silently. `mdv_outline` is pushed onto the core ruler
 * *after* `markdown-it-anchor`'s own rule, by the same `markdownIt` call — so
 * "runs after ids are assigned and deduplicated" is guaranteed by statement
 * order inside one function, not by a registry line someone could reorder.
 *
 * **The seam back to `renderMarkdown`** is `env`. markdown-it threads one env
 * object through every rule of a parse and stores nothing on the instance,
 * which is what makes a single shared parser safe. `renderMarkdown` mints a
 * fresh env per parse and reads `env.headings` off it afterwards; this rule
 * pushes into it. Neither side imports the other — the shape they meet on is
 * `lib/markdown-env.ts`. Disabled, nothing pushes, the outline is empty, and
 * that is correct: there are no ids for it to point at.
 *
 * On `markdown-emoji`: `headingText` counts the `emoji` token type so a
 * shortname in a heading contributes its character rather than a hole. That is
 * a dependency on a token type *name*, which either exists in the stream or
 * does not — filtering for a type nothing emits is a no-op. It needs no `after`
 * and would not be fixed by one.
 */

import type MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import type Token from 'markdown-it/lib/token.mjs';

import { TOC_LEVELS } from '../../lib/config.ts';
import { renderEnvOf, type RenderEnv } from '../../lib/markdown-env.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';
import { slugify } from '../../lib/slug.ts';

/**
 * The visible text of a heading, as tokens rather than as rendered HTML: the
 * latter has already been entity-escaped, so "Install & Setup" comes back as
 * "Install &amp; Setup" and slugs to `install-amp-setup`. That was a shipped
 * bug once, and it is why this is the input to both the slug and the outline.
 */
function headingText(tokens: Token[]): string {
  return tokens
    .filter((token) => ['text', 'code_inline', 'emoji'].includes(token.type))
    .map((token) => token.content)
    .join('');
}

/** Runs after `anchor`, so every heading already carries its final id. */
function collectOutline(tokens: Token[], env: RenderEnv): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'heading_open') continue;

    const level = Number(token.tag.slice(1));
    const id = token.attrGet('id');
    if (!id || !TOC_LEVELS.includes(level)) continue;

    env.headings.push({
      id,
      text: headingText(tokens[index + 1]?.children ?? []).trim(),
      level,
    });
  }
}

export const markdownHeadingsPlugin: Plugin = {
  id: 'markdown-headings',
  name: 'Heading anchors and outline',
  description: 'Gives every heading a GitHub-compatible id, and builds the outline from them.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.use(anchor, {
      // Every level, not just TOC_LEVELS: an `h5` is still a link target someone
      // may have written an anchor against, and `components/HeadingFold.tsx`
      // folds all six.
      level: [1, 2, 3, 4, 5, 6],
      // Off, because it is on by default and would put `tabindex="-1"` on every
      // heading in the document — a tab stop the viewer never asked for.
      tabIndex: false,
      getTokensText: headingText,
      slugifyWithState: (text: string, state: { env: unknown }) => {
        const slug = slugify(text);
        if (slug) return slug;

        // A heading of pure punctuation ("???") still has to be addressable.
        const env = renderEnvOf(state.env);
        env.unnamed += 1;
        return `section-${env.unnamed}`;
      },
      // Two headings with the same words are common ("Options" under each
      // command). markdown-it-anchor's own counter is per-parse and starts at 1,
      // which is exactly what GitHub does: `options`, `options-1`.
      uniqueSlugStartIndex: 1,
    });

    // Pushed, so it lands at the end of the core chain — and pushed *here*,
    // immediately after the `use` above, so it lands after anchor's rule
    // whatever else the registry loads before or after this plugin.
    md.core.ruler.push('mdv_outline', (state) => {
      collectOutline(state.tokens, renderEnvOf(state.env));
    });
  },
};
