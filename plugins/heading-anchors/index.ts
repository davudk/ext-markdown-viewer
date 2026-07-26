/**
 * Heading anchors: the plugin, assembled.
 *
 * The styles stay in `components/document.css` alongside the copy button's —
 * both are written as `.mdv-body .mdv-anchor`, neither was ever scoped to a
 * component, and a disabled plugin leaves no element for them to match.
 */

import { createHeadingAnchorsPlugin } from './plugin.ts';

export const headingAnchorsPlugin = createHeadingAnchorsPlugin();
