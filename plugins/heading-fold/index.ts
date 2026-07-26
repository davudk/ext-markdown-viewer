/**
 * Collapsible sections: the plugin, assembled.
 *
 * No JSX here — this plugin renders nothing — so the seam exists purely to keep
 * the stylesheet import, which only a bundler can resolve, out of the module the
 * bare test runner loads.
 */

import { createHeadingFoldPlugin } from './plugin.ts';

import './heading-fold.css';

export const headingFoldPlugin = createHeadingFoldPlugin();
