/**
 * Assembly only.
 *
 * The lifecycle lives in `plugin.ts` because the bare node test runner refuses
 * a `.tsx` file outright — so a plugin that names its components directly is a
 * plugin no unit test can reach. Injecting them keeps every teardown decision,
 * and the capability-to-row mapping, in a module the runner can import.
 */

import { CommandPalette } from './CommandPalette.tsx';
import { createCommandPalettePlugin } from './plugin.ts';

export const commandPalettePlugin = createCommandPalettePlugin({
  Panel: CommandPalette,
});
