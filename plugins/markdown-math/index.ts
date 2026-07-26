/**
 * `$x^2$` and `$$…$$` — tokenized here, rendered by the add-on.
 *
 * Two things live in this file that look separable and are not:
 *
 *  1. **The tokenizer must not outrank a code span.** Under `marked` this was
 *     free: its own `codespan` and `fences` tokenizers claimed `` `$x$` ``
 *     before the math extension saw the `$`. markdown-it orders rules
 *     differently — the KaTeX plugin installs `math_inline` with
 *     `inline.ruler.after('escape', …)`, which is *before* `backticks` — so it
 *     has to be re-established. `mdv_code_span_wins` is inserted with
 *     `inline.ruler.before('math_inline', …)`, which means the ordering is
 *     expressed against the rule it must beat, by name, at the moment that rule
 *     exists. It cannot be got wrong by a registry edit, because both halves are
 *     installed by this one function in this one order.
 *
 *  2. **Rendering is deferred.** The plugin's four *renderer* rules each called
 *     `katex.renderToString`, dragging the whole of KaTeX into every document,
 *     math or not. They are replaced by a placeholder carrying the TeX, which
 *     `entrypoints/katex-addon.ts` fills in once injected. The tokenizer stays,
 *     because it is the only stage that can tell `$x$` from `` `$x$` ``.
 *
 * Disabled, a dollar sign is a dollar sign: no placeholder, no tokenizer, and
 * `A $ B \`c\` D $ E` is prose containing a code span, same as when it is on.
 */

import katexPluginModule from '@vscode/markdown-it-katex';
import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type Token from 'markdown-it/lib/token.mjs';

import {
  KATEX_OPTIONS,
  MATH_DISPLAY_CLASS,
  MATH_INLINE_CLASS,
  MATH_PLACEHOLDER_CLASS,
} from '../../lib/config.ts';
import { escapeHtml } from '../../lib/escape.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

/**
 * The KaTeX plugin is CommonJS. Bundlers unwrap its `exports.default` for us;
 * bare node — which is what runs the tests — hands back `module.exports` whole.
 */
const katexPlugin = (
  katexPluginModule as unknown as { default?: typeof katexPluginModule }
).default ?? katexPluginModule;

const DOLLAR = 0x24;

/**
 * Refuses a `$` that would open before a code span and close after it.
 *
 * Most of the code-span-beats-math property survives the move to markdown-it
 * untouched, and that was worth measuring rather than assuming: fenced and
 * indented code are block rules that both run before `math_block`, and a code
 * span still wins whenever its backtick is the first special character the
 * tokenizer reaches, which covers `` `$x$` `` itself.
 *
 * What does not survive is ``A $ B `c` D $ E``, where the plugin's
 * closing-delimiter scan walks straight through the backticks and swallows the
 * span whole. So: if a backtick appears before the next `$`, this `$` cannot be
 * an opening delimiter, and it is handed back as literal text. Refusing costs
 * one character, and the tokenizer tries again at the next `$`, so a document
 * that mixes prose dollars, code spans and real math still resolves all three.
 */
function refuseMathAcrossCodeSpans(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== DOLLAR) return false;

  const backtick = state.src.indexOf('`', state.pos + 1);
  if (backtick === -1 || backtick >= state.posMax) return false;

  const dollar = state.src.indexOf('$', state.pos + 1);
  // No closing candidate at all means the math rule would decline anyway; let
  // it, rather than second-guessing a `$` that is plainly just a dollar sign.
  if (dollar === -1 || dollar >= state.posMax || dollar < backtick) return false;

  if (!silent) state.pending += '$';
  state.pos += 1;
  return true;
}

/**
 * The TeX is the element's text rather than an attribute (see
 * MATH_PLACEHOLDER_CLASS in config.ts, and `ALLOW_DATA_ATTR: false`), which
 * also settles what happens when the add-on never arrives: the formula reads as
 * its own source, which is degraded but never blank.
 */
function mathPlaceholder(tex: string, display: boolean): string {
  const kind = display ? MATH_DISPLAY_CLASS : MATH_INLINE_CLASS;
  return `<span class="${MATH_PLACEHOLDER_CLASS} ${kind}">${escapeHtml(tex)}</span>`;
}

/** `$`1+1`$` — the plugin accepts a backticked body, so the TeX excludes them. */
function mathContent(raw: string): string {
  return raw.length > 2 && raw.startsWith('`') && raw.endsWith('`')
    ? raw.slice(1, -1)
    : raw;
}

function deferMathRendering(md: MarkdownIt): void {
  const inline = (tokens: Token[], index: number) =>
    mathPlaceholder(mathContent(tokens[index].content), false);

  // A trailing newline, as the plugin's own block renderer emits: without it
  // two consecutive display formulae run together in the HTML source.
  const display = (tokens: Token[], index: number) =>
    `${mathPlaceholder(tokens[index].content, true)}\n`;

  md.renderer.rules.math_inline = inline;
  md.renderer.rules.math_block = display;
  // `$$…$$` written mid-paragraph, and the bare `\begin{}` form. The latter is
  // switched off in KATEX_OPTIONS and mints no token today; overriding it anyway
  // means turning it on cannot quietly put KaTeX back into the parse.
  md.renderer.rules.math_inline_block = display;
  md.renderer.rules.math_inline_bare_block = display;
}

export const markdownMathPlugin: Plugin = {
  id: 'markdown-math',
  name: 'Math',
  description: 'Reads `$x$` and `$$x$$` as TeX, rendered on demand by the KaTeX add-on.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.use(katexPlugin, KATEX_OPTIONS);

    // Both statements below depend on `use` above having run, and on nothing
    // else in the registry. Keeping them here rather than splitting the
    // "code spans win" rule into a plugin of its own is deliberate: two plugins
    // whose correctness depends on which loaded first is precisely the coupling
    // `after:` cannot express safely.
    deferMathRendering(md);
    md.inline.ruler.before('math_inline', 'mdv_code_span_wins', refuseMathAcrossCodeSpans);
  },
};
