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
 * What is left is the markup. That is the shape the plugin architecture is
 * aiming for: the shell renders the document, and everything layered over it is
 * a plugin that can be disabled.
 *
 * `showRaw` belongs to the shell, and so does the control that flips it: the
 * top-right corner holds contributed chrome too, and only the shell can see
 * everything competing for it. This component only reflects the flag.
 */
export function Document({
  html,
  source,
  showRaw,
}: {
  html: string;
  source: string;
  showRaw: boolean;
}) {
  // A stable object keeps React from re-setting innerHTML — it compares the
  // string, but there is no reason to hand it a new wrapper every render.
  const markup = useMemo(() => ({ __html: html }), [html]);

  return (
    // A single root, not a fragment: `.mdv-main` stacks its children, and the
    // two views below have to be one item in that stack.
    <div className="mdv-doc">
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
