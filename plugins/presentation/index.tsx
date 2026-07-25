/**
 * Presentation mode: the plugin, assembled.
 *
 * The lifecycle is in `plugin.ts` and the views are in `Presentation.tsx`; this
 * is the seam between them. It exists as its own file because the bare test
 * runner cannot load JSX at all — `node --experimental-strip-types` refuses a
 * `.tsx` file outright — so a plugin that names its components directly is a
 * plugin no unit test can reach. Injecting them keeps every teardown decision
 * in a module the runner can import.
 */

import { createPresentationPlugin } from './plugin.ts';
import { PresentationDeck, PresentationLauncher } from './Presentation.tsx';

export const presentationPlugin = createPresentationPlugin({
  Launcher: PresentationLauncher,
  Deck: PresentationDeck,
});
