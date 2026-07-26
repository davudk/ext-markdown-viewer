/**
 * The image viewer: the plugin, assembled.
 *
 * The lifecycle — claiming the document's images, opening the overlay, giving
 * focus back — is in `plugin.ts`, which the bare test runner can load. The
 * overlay is a `.tsx`, which it cannot. This is the seam.
 */

import { createLightboxPlugin } from './plugin.ts';
import { LightboxOverlay } from './Lightbox.tsx';

export const lightboxPlugin = createLightboxPlugin(LightboxOverlay);
