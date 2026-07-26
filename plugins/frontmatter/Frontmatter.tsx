import { useMemo } from 'react';

import { useDocument, usePluginSettings } from '../../lib/plugins/react.tsx';

import {
  cardModel,
  parseFrontmatter,
  type FrontmatterSettings,
} from './plugin.ts';

import './frontmatter.css';

/**
 * The metadata card, above the document.
 *
 * **Every value here is text, and nothing is HTML.** The card is rendered into
 * `document.before`, outside the body DOMPurify sanitizes, from a file any site
 * can serve — so there is no `dangerouslySetInnerHTML` anywhere in this file
 * and there must never be one. React escapes a string child; that is the whole
 * defence, and `cardModel` flattens every leaf to a string precisely so this
 * component has nothing but strings to render.
 *
 * It re-parses `doc.source` rather than being handed the block by the parser:
 * see the note in `plugin.ts` on where the split goes. `useMemo` keeps that to
 * once per document.
 *
 * `<details>` rather than a button and a piece of state, because the browser
 * already owns disclosure — including the keyboard, the accessible name and
 * find-in-page expanding it.
 */
export function Frontmatter() {
  const doc = useDocument();
  const { display } = usePluginSettings<FrontmatterSettings>();

  const matter = useMemo(() => parseFrontmatter(doc.source), [doc.source]);

  // The raw view already shows the block — it shows the whole file — so a card
  // above it would be the same metadata twice.
  if (!matter || doc.isRaw || display === 'hidden') return null;

  const asCard = display === 'card' && matter.data !== null;
  const model = asCard ? cardModel(matter.data!) : null;

  return (
    // `data-mdv-chrome`: this is not the document. The print rule and Search
    // both key off the attribute, so the card neither prints nor becomes a
    // search hit for words the author never wrote in the text.
    <details className="mdv-frontmatter" data-mdv-chrome open>
      <summary className="mdv-frontmatter-summary">
        <span className="mdv-frontmatter-label">
          {model?.title ?? 'Frontmatter'}
        </span>
      </summary>

      {model ? (
        <div className="mdv-frontmatter-body">
          {model.author || model.date ? (
            <p className="mdv-frontmatter-byline">
              {model.author ? <span>{model.author}</span> : null}
              {model.author && model.date ? (
                <span className="mdv-frontmatter-dot" aria-hidden="true">
                  ·
                </span>
              ) : null}
              {model.date ? <span>{model.date}</span> : null}
            </p>
          ) : null}

          {model.tags.length > 0 ? (
            <ul className="mdv-frontmatter-tags">
              {model.tags.map((tag, index) => (
                <li key={`${tag}-${index}`} className="mdv-frontmatter-tag">
                  {tag}
                </li>
              ))}
            </ul>
          ) : null}

          {model.fields.length > 0 ? (
            <dl className="mdv-frontmatter-fields">
              {model.fields.map((field, index) => (
                <div key={`${field.key}-${index}`} className="mdv-frontmatter-field">
                  <dt>{field.key}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : (
        <div className="mdv-frontmatter-body">
          {/* The block could not be read as fields. Say so, once, quietly —
              and then show what the author actually wrote, which is the only
              thing that can help them fix it. */}
          {matter.error ? (
            <p className="mdv-frontmatter-note">{matter.error}</p>
          ) : null}
          <pre className="mdv-frontmatter-raw">{matter.raw}</pre>
        </div>
      )}
    </details>
  );
}
