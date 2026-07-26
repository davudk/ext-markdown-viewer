/**
 * What the page is made of, as data.
 *
 * The table of contents and the page body are rendered from this one list, in
 * this one order, so the nav cannot list a section the page does not have and
 * the scroll-spy cannot highlight entries out of sequence. Adding a plugin adds
 * a card and an entry, together, with nothing to keep in step by hand.
 */

import { ownsGlobals } from './owned';
import { PLUGINS, type AnyPlugin } from './plugins';

export interface SectionEntry {
  /** The element id, the fragment, and the scroll-spy's handle. */
  id: string;
  label: string;
}

/**
 * The hand-written sections, in page order.
 *
 * These are the ones no schema expresses — a permission prompt, a browser
 * setting, a list of granted origins, per-document pins and a file picker are
 * not settings with types, they are small applications. They stay at the top
 * because they are about whether the extension runs at all, which is a
 * different question from how a document looks.
 *
 * Pinned documents sits here rather than under the theme plugin even though a
 * pin is a theme: it is a list of documents, not a preference, and unpinning
 * one has to keep working when the theme plugin is switched off.
 *
 * About is deliberately absent. It is provenance rather than a setting, and it
 * moved to the foot of the nav column — which keeps the contents exactly the
 * two parts it claims to be, and stops a card nobody navigates to sitting
 * between the general sections and the plugins.
 */
export const GENERAL_SECTIONS: readonly SectionEntry[] = [
  { id: 'sec-rendering', label: 'Rendering' },
  { id: 'sec-files', label: 'Local files' },
  { id: 'sec-sites', label: 'Sites' },
  { id: 'sec-pins', label: 'Pinned documents' },
  { id: 'sec-backup', label: 'Backup' },
];

export function pluginSectionId(pluginId: string): string {
  return `sec-plugin-${pluginId}`;
}

/**
 * The four kinds of plugin, derived rather than listed.
 *
 * Thirty-two switches in one flat column is a wall; the same thirty-two under
 * four headings is a menu. But a hand-written id-to-group table would be the
 * exact second list the plugin registry exists to abolish — it would go stale
 * the first time someone added a plugin and did not know to edit this file. So
 * the group is read off the plugin itself:
 *
 *   Appearance   declares globals of its own (see `owned.ts`)
 *   Markdown     extends the parser, so it changes what a document *is*
 *   Panels       contributes UI to a region, so it puts something on screen
 *   Behaviour    everything else: it acts, but adds no surface
 *
 * A new plugin lands in the right group by construction, and the worst case for
 * one that fits none of them is "Behaviour", which is true of anything that
 * neither parses nor renders.
 */
export interface PluginGroup {
  name: string;
  /** One line under the heading, so the grouping explains itself. */
  note: string;
  plugins: readonly AnyPlugin[];
}

type GroupKey = 'appearance' | 'panels' | 'markdown' | 'behaviour';

const GROUP_META: Record<GroupKey, { name: string; note: string }> = {
  appearance: {
    name: 'Appearance',
    note: 'How every document is drawn.',
  },
  panels: {
    name: 'Panels and overlays',
    note: 'Features with something on screen.',
  },
  markdown: {
    name: 'Markdown syntax',
    note: 'What the parser understands. Takes effect on the next render.',
  },
  behaviour: {
    name: 'Behaviour',
    note: 'Features that act on a document without a surface of their own.',
  },
};

/** Display order, which is also page order. */
const GROUP_ORDER: readonly GroupKey[] = [
  'appearance',
  'panels',
  'markdown',
  'behaviour',
];

function groupOf(plugin: AnyPlugin): GroupKey {
  if (ownsGlobals(plugin.id)) return 'appearance';
  // Checked before `ui`: the frontmatter plugin does both, and what it mainly
  // is, is a parser extension.
  if (plugin.markdownIt) return 'markdown';
  if (plugin.ui && plugin.ui.length > 0) return 'panels';
  return 'behaviour';
}

export const PLUGIN_GROUPS: readonly PluginGroup[] = GROUP_ORDER.map((key) => ({
  ...GROUP_META[key],
  // Registry order within a group, which is load order — the nearest thing to
  // an intentional sequence that exists, and stable across runs.
  plugins: PLUGINS.filter((plugin) => groupOf(plugin) === key),
})).filter((group) => group.plugins.length > 0);

/** Every section on the page, in the order they appear in it. */
export const ALL_SECTION_IDS: readonly string[] = [
  ...GENERAL_SECTIONS.map((section) => section.id),
  ...PLUGIN_GROUPS.flatMap((group) =>
    group.plugins.map((plugin) => pluginSectionId(plugin.id)),
  ),
];
