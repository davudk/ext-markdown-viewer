/**
 * Copy buttons on code blocks: the plugin, assembled.
 *
 * The seam exists for the same reason it does in every other plugin here — the
 * bare test runner loads `plugin.ts` and nothing that reaches a bundler-only
 * import. The stylesheet is that import, and it lives on this side of the line.
 *
 * The styles themselves stay in `components/document.css`: they are written as
 * `.mdv-body .mdv-copy`, they were never scoped to a component, and a disabled
 * plugin leaves no element for them to match.
 */

import { createCodeCopyPlugin } from './plugin.ts';

export const codeCopyPlugin = createCodeCopyPlugin();
