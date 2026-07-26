/**
 * Reading status: the plugin, assembled.
 *
 * The settings and the region live in `plugin.ts`; the readout is a `.tsx` the
 * bare test runner cannot load. This is the seam between them.
 */

import { createReadingStatusPlugin } from './plugin.ts';
import { ReadingStatus } from './ReadingStatus.tsx';

export const readingStatusPlugin = createReadingStatusPlugin(ReadingStatus);
