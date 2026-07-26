/**
 * Compare documents: the plugin, assembled.
 *
 * The lifecycle, the overlays and the two capabilities are in `plugin.ts`; the
 * three views are in `Diff.tsx`. This file is the seam, and exists because
 * `node --experimental-strip-types` refuses a `.tsx` file outright — so a plugin
 * that names its components directly is a plugin no unit test can reach.
 */

import { DiffMenu, DiffPicker, DiffView } from './Diff.tsx';
import { createDiffPlugin } from './plugin.ts';

export const diffPlugin = createDiffPlugin({
  Menu: DiffMenu,
  Picker: DiffPicker,
  View: DiffView,
});
