/**
 * Word count, reading time, and a progress bar.
 *
 * Migrated from `components/ReadingStatus.tsx`. Two shell settings became this
 * plugin's own schema, and the `showRaw` prop became `ctx.document.isRaw` read
 * by the component — so the shell no longer computes `settings.readingStats &&
 * !showRaw` on the plugin's behalf, which is one fewer place for the two halves
 * of a feature's enabled state to disagree.
 *
 * The readout is a single fixed layer contributed to `document.after`. Fixed
 * rather than in flow is what keeps it out of the shell's flex row — a top-level
 * sibling there would be granted `flex: 1 1 auto` by viewer.css and become a
 * second column — and what guarantees it can never shift the document by a
 * pixel.
 *
 * Split from `index.tsx` and taking the component as a parameter for the usual
 * reason: `node --experimental-strip-types` refuses a `.tsx` file outright, so a
 * plugin naming its component directly is a plugin no unit test can load.
 */

import type { ComponentType } from 'react';

import type { ReadingStats } from '../../lib/reading.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const READING_STATUS_PLUGIN_ID = 'reading-status';

/** Where the readout lands. Named for the place, never for what fills it. */
export const READING_STATUS_REGION = 'document.after';

/**
 * The two halves are separate settings because readers want them separately:
 * the progress bar is ambient and the word count is a claim about the document,
 * and someone who distrusts reading-time estimates still wants the bar.
 */
const settings = {
  showStats: {
    type: 'boolean',
    default: true,
    label: 'Word count and reading time',
    description: 'Counted from the rendered document. Code blocks are left out, and said so.',
  },
  showProgress: {
    type: 'boolean',
    default: true,
    label: 'Reading progress bar',
    description: 'How much of the document has passed the bottom of the window.',
  },
} as const;

export type ReadingStatusSettings = typeof settings;

export function createReadingStatusPlugin(
  component: ComponentType,
): Plugin<ReadingStatusSettings> {
  return {
    id: READING_STATUS_PLUGIN_ID,
    name: 'Reading status',
    description: 'How long the document is, and how far through it you are.',
    apiVersion: PLUGIN_API_VERSION,
    enabledByDefault: true,
    settings,

    // No `setup`: there is nothing imperative to own. The scroll listener and
    // the resize observer belong to the bar that reads them, so they live in the
    // component's own effect and unmount with it — which is also what makes
    // disabling the plugin leave nothing behind, with no teardown to write.
    ui: [{ region: READING_STATUS_REGION, key: 'reading', component }],
  };
}

/**
 * What the headline number is counting.
 *
 * CJK text is counted per character, so calling the total "words" on a Chinese
 * or Japanese document would be a plain misstatement. The switch is on which
 * kind of unit is in the majority, because a mixed document has to be called
 * something and the majority is the honest choice.
 *
 * Exported from here rather than living beside the JSX so the test runner can
 * reach it: it is the one piece of this plugin that is a decision rather than a
 * rendering.
 */
export function unitOf({ words, cjkCharacters }: ReadingStats): string {
  return cjkCharacters * 2 > words ? 'characters' : 'words';
}
