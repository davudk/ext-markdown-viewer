/**
 * Frontmatter: the plugin, assembled.
 *
 * The parsing and the settings live in `plugin.ts`; the card is a `.tsx` the
 * bare test runner cannot load. This is the seam between them.
 */

import { Frontmatter } from './Frontmatter.tsx';
import { createFrontmatterPlugin } from './plugin.ts';

export const frontmatterPlugin = createFrontmatterPlugin(Frontmatter);
