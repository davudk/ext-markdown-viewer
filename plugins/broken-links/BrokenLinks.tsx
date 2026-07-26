import { useSyncExternalStore } from 'react';

import { usePlugin } from '../../lib/plugins/react.tsx';

import {
  BROKEN_LINKS_OVERLAY,
  brokenLinks,
  type BrokenLinksSettings,
} from './plugin.ts';
import type { BrokenLink } from './detect.ts';

import './broken-links.css';

/**
 * The count, and the list behind it.
 *
 * Both read the same store the enhancement pass writes. `useSyncExternalStore`
 * rather than an effect: the pass runs in the host's post-paint frame, which is
 * outside React entirely, and this is the subscription React is designed to be
 * told about.
 */
function useBrokenLinks(): readonly BrokenLink[] {
  return useSyncExternalStore(brokenLinks.subscribe, brokenLinks.get, () => EMPTY);
}

/** A stable server/initial snapshot; a new `[]` each call would loop. */
const EMPTY: readonly BrokenLink[] = [];

/* -------------------------------------------------------------------------- */
/* The count                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * "3 broken links", parked in the corner.
 *
 * Renders nothing when there are none, which is the ordinary case for a healthy
 * document — a badge reading "0 broken links" is a permanent accusation that
 * has to be read every time to be dismissed.
 */
export function BrokenLinkCount() {
  const ctx = usePlugin<BrokenLinksSettings>();
  const links = useBrokenLinks();

  if (links.length === 0) return null;

  const label = links.length === 1 ? '1 broken link' : `${links.length} broken links`;

  return (
    <button
      type="button"
      className="mdv-broken-count"
      // Read by the print rule in viewer.css and skipped by Search, so this
      // readout is never itself a search result.
      data-mdv-chrome
      title={`${label} in this document. Show them.`}
      onClick={() =>
        ctx.ui.openOverlay({
          id: BROKEN_LINKS_OVERLAY,
          label: 'Broken links',
          component: BrokenLinkList,
        })
      }
    >
      <WarnIcon />
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every broken link, in document order, rendered by the host inside its managed
 * overlay — so there is no z-index here, no focus trap and no Escape handler.
 *
 * `close` is the host's, and picking a row uses it: the reader asked to be
 * taken to the link, and leaving the dialog covering it would answer half the
 * request.
 */
export function BrokenLinkList({ close }: { close: () => void }) {
  const links = useBrokenLinks();

  return (
    <div className="mdv-broken-panel" data-mdv-chrome>
      <h2 className="mdv-broken-title">
        {links.length === 1 ? '1 broken link' : `${links.length} broken links`}
      </h2>
      <p className="mdv-broken-note">
        Anchors are checked against this document’s headings, and relative links
        against the open folder. Links to other sites are never checked.
      </p>

      <ul className="mdv-broken-list">
        {links.map((link, index) => (
          <li key={`${link.href}:${index}`}>
            <button
              type="button"
              className="mdv-broken-row"
              onClick={() => {
                close();
                link.element.scrollIntoView({ block: 'center' });
              }}
            >
              <span className="mdv-broken-row-text">{link.text || link.href}</span>
              <code className="mdv-broken-row-href">{link.href}</code>
              <span className="mdv-broken-row-reason">{link.reason}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Inline, because the extension never loads a resource of any kind. */
function WarnIcon() {
  return (
    <svg
      className="mdv-icon"
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2.4 1.6 13.6h12.8L8 2.4Z" />
      <path d="M8 6.6v3.1M8 11.7v.1" />
    </svg>
  );
}
