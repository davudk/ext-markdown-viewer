/**
 * Link previews: the plugin, assembled.
 *
 * No JSX here — the panel is DOM, because it is created and destroyed on a
 * timer outside React's tree — so the seam exists purely to keep the stylesheet
 * import, which only a bundler can resolve, out of the module the bare test
 * runner loads.
 */

import { createHoverPreviewsPlugin } from './plugin.ts';

import './hover-previews.css';

export const hoverPreviewsPlugin = createHoverPreviewsPlugin();
