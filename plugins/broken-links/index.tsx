/**
 * Broken links: the plugin, assembled.
 *
 * The tiers, the settings and the ledger live in `plugin.ts`; the count and the
 * list are a `.tsx` the bare test runner cannot load. This is the seam.
 */

import { BrokenLinkCount } from './BrokenLinks.tsx';
import { createBrokenLinksPlugin } from './plugin.ts';

export const brokenLinksPlugin = createBrokenLinksPlugin(BrokenLinkCount);
