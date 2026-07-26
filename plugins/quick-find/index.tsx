/**
 * Quick find: the plugin, assembled.
 *
 * The lifecycle is in `plugin.ts` and the panel is in `QuickFind.tsx`; this is
 * the seam between them, and it exists because `node --experimental-strip-types`
 * refuses a `.tsx` file outright.
 */

import { QuickFind } from './QuickFind.tsx';
import { createQuickFindPlugin } from './plugin.ts';

export const quickFindPlugin = createQuickFindPlugin({ Panel: QuickFind });
