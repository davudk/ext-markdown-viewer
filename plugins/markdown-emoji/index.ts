/**
 * `:rocket:` → 🚀, offline.
 *
 * The bundled table is `full`, which is the whole Unicode shortname set and no
 * network call — the reason node-emoji was here before markdown-it was. Its
 * ASCII shortcuts (`:)`, `:-(`) are switched off: rewriting punctuation that an
 * author typed as punctuation is a surprise, not a feature, and `(below:)` in
 * ordinary prose is the case that proves it.
 *
 * `markdown-headings` counts the `emoji` token type when it builds a heading's
 * text, so a shortname in a heading contributes its character to the slug
 * rather than a hole. That is a coupling on the token *type name*, which is
 * part of this plugin's output, not on load order — see the note there.
 */

import { full as emoji } from 'markdown-it-emoji';
import type MarkdownIt from 'markdown-it';

import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const markdownEmojiPlugin: Plugin = {
  id: 'markdown-emoji',
  name: 'Emoji shortnames',
  description: 'Turns `:rocket:` into an emoji, from a bundled table.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.use(emoji, { shortcuts: {} });
  },
};
