/**
 * GitHub's `> [!NOTE]` callouts.
 *
 * The markup — wrapper, title, icon — is `lib/alerts.ts`, not this file, because
 * `markdown-containers` renders `:::note` into exactly the same shape and the
 * two plugins may not import each other. Disabled, a `> [!NOTE]` block is what
 * it always was underneath: an ordinary blockquote whose first line reads
 * `[!NOTE]`.
 */

import githubAlerts from 'markdown-it-github-alerts';
import type MarkdownIt from 'markdown-it';

import { ALERT_ICONS } from '../../lib/alerts.ts';
import { ALERT_CLASS_PREFIX, ALERT_MARKERS } from '../../lib/config.ts';
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

export const markdownGithubAlertsPlugin: Plugin = {
  id: 'markdown-github-alerts',
  name: 'GitHub alerts',
  description: 'Renders `> [!NOTE]`, `> [!WARNING]` and the rest as callouts.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,

  markdownIt(md: MarkdownIt) {
    md.use(githubAlerts, {
      markers: [...ALERT_MARKERS],
      classPrefix: ALERT_CLASS_PREFIX,
      icons: ALERT_ICONS,
    });
  },
};
