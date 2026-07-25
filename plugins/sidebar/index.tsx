/**
 * The sidebar plugin, assembled.
 *
 * Everything except the component is in `plugin.ts`, which the bare test runner
 * can load; this file is the one line that cannot be tested because a `.tsx`
 * file has no loader outside the bundler.
 */

import { createSidebarPlugin } from './plugin.ts';
import { SidebarNav } from './SidebarNav.tsx';

export const sidebarPlugin = createSidebarPlugin(SidebarNav);
