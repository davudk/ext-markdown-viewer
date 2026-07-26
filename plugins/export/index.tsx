/**
 * Export: the plugin, assembled.
 *
 * The lifecycle and the `export` capability are in `plugin.ts`, the view is in
 * `ExportMenu.tsx`, and this is the seam between them. It exists as its own file
 * because `node --experimental-strip-types` refuses a `.tsx` file outright, so a
 * plugin that names its components directly is a plugin no unit test can reach.
 */

import { ExportMenu } from './ExportMenu.tsx';
import { createExportPlugin } from './plugin.ts';

export const exportPlugin = createExportPlugin({ Menu: ExportMenu });
