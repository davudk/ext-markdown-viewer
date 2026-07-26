import { useMemo } from 'react';

import './document.css';

/**
 * The document body, and the raw/rendered toggle over it.
 *
 * The body is injected HTML, so React does not own a single node inside it —
 * and this component now does nothing *to* it. The copy buttons, the anchor
 * links and the clipboard handling that used to live here are the `code-copy`
 * and `heading-anchors` plugins; both graft their affordances through
 * `ctx.document.enhance`, which is one pass for the whole page instead of one
 * per feature, and both undo exactly what they added when they are turned off.
 *
 * What is left is the markup and one button. That is the shape the plugin
 * architecture is aiming for: the shell renders the document, and everything
 * layered over it is a plugin that can be disabled.
 *
 * `showRaw` belongs to the shell; this component only reflects it and reports
 * the toggle back.
 */
export function Document({
  html,
  source,
  showRaw,
  onToggleRaw,
}: {
  html: string;
  source: string;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  // A stable object keeps React from re-setting innerHTML — it compares the
  // string, but there is no reason to hand it a new wrapper every render.
  const markup = useMemo(() => ({ __html: html }), [html]);

  return (
    // A single root, not a fragment: `.mdv > :not(nav)` in viewer.css grants
    // `flex: 1 1 auto` to every non-nav child of the shell, so top-level
    // siblings here would be laid out side by side in the flex row.
    <div className="mdv-doc">
      <div className="mdv-toolbar" data-mdv-chrome>
        <button
          type="button"
          className="mdv-tool"
          aria-pressed={showRaw}
          aria-label={showRaw ? 'Show rendered document' : 'Show raw markdown'}
          onClick={onToggleRaw}
        >
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
            {showRaw ? (
              <path d="M3 3.4h10M3 6.6h10M3 9.8h7M3 13h5" />
            ) : (
              <>
                <path d="M5.6 4.8 2.4 8l3.2 3.2" />
                <path d="M10.4 4.8 13.6 8l-3.2 3.2" />
              </>
            )}
          </svg>
          Raw
        </button>
      </div>

      {/* Distinct keys, so switching views swaps the element instead of asking
          React to reconcile injected HTML against real children. */}
      {showRaw ? (
        <main key="raw" className="mdv-body">
          {/* Text child, never innerHTML: the source is untrusted and this view
              exists precisely to show it as characters. */}
          <pre className="mdv-raw">{source}</pre>
        </main>
      ) : (
        <main key="rendered" className="mdv-body" dangerouslySetInnerHTML={markup} />
      )}
    </div>
  );
}
