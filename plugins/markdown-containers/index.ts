/**
 * `:::note` containers, as MkDocs, Docusaurus and VitePress spell them.
 *
 * Each name maps onto one of the five alert kinds rather than introducing a
 * palette of its own — `:::danger` and `> [!CAUTION]` mean the same thing to a
 * reader — so this renders through `lib/alerts.ts`, the same markup
 * `markdown-github-alerts` emits.
 *
 * `after: ['markdown-github-alerts']` is ordering hygiene rather than a
 * requirement: the two claim disjoint syntax and neither touches the other's
 * rules. Declaring it anyway means the pair loads in one fixed order whatever
 * the registry says, so if they ever do overlap the behaviour is the same in
 * every build instead of depending on which line came first.
 *
 * Disabled, `:::tip` is a paragraph of literal colons — which is also what an
 * unrecognised container name does while it is enabled.
 */

import container from 'markdown-it-container';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';

import { alertOpen } from '../../lib/alerts.ts';
import { CONTAINER_TYPES } from '../../lib/config.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const markdownContainersPlugin: Plugin = {
  id: 'markdown-containers',
  name: 'Container callouts',
  description: 'Renders `:::note` … `:::` blocks as callouts.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,
  after: ['markdown-github-alerts'],

  markdownIt(md: MarkdownIt) {
    for (const { name, title, kind } of CONTAINER_TYPES) {
      md.use(container, name, {
        render: (tokens: Token[], index: number) =>
          tokens[index].nesting === 1
            ? // `:::note Heads up` names its own title; bare `:::note` takes the
              // default. The info string is the raw line, name included.
              `${alertOpen(kind, tokens[index].info.trim().slice(name.length).trim() || title)}\n`
            : '</div>\n',
      });
    }
  },
};
