import { useEffect, useState } from 'react';

import { loadFuse, type FuseConstructor } from '@/lib/commands';

import './filter-box.css';

/**
 * The filter box the two sidebar tabs share, and the hook that loads Fuse.
 *
 * Both lived in `CommandPalette.tsx` while the palette was a component of the
 * shell. That stopped working when the palette became a plugin: the outline and
 * the file tree are plugins too, and a plugin importing another plugin is the
 * one thing the API forbids — it makes two features impossible to disable
 * independently. Neither of these belongs to the palette anyway. They belong to
 * whoever is filtering a list, which is three surfaces and counting, so they sit
 * in `components/` where all three can reach them without reaching for
 * each other.
 *
 * Nothing else changed: same matcher, same announcement timing, same
 * escape-to-clear, same stylesheet rules.
 */

/** How long the count has to hold still before it is announced. */
const ANNOUNCE_MS = 550;

/**
 * Fuse's constructor once it is available, and null until then.
 *
 * `loadFuse` memoises across every caller — the module is resolved once per page
 * however many surfaces ask for it. Nothing here blocks on it: every caller
 * builds a working substring matcher from the null and swaps in the fuzzy one
 * on the render after it arrives.
 */
export function useFuzzy(): FuseConstructor | null {
  const [fuse, setFuse] = useState<FuseConstructor | null>(null);

  useEffect(() => {
    let alive = true;
    void loadFuse().then((loaded) => {
      // Wrapped in an updater: a constructor *is* a function, and handing one
      // to a setter directly would have React call it as a reducer.
      if (alive && loaded) setFuse(() => loaded);
    });
    return () => {
      alive = false;
    };
  }, []);

  return fuse;
}

/**
 * A one-line filter over a list that is already on screen.
 *
 * The same idea as the palette at a smaller scale — the same matcher, the same
 * "typing narrows a list of discrete things", the same stylesheet. Two copies of
 * this would be two places for the announcement timing and the escape-to-clear
 * behaviour to drift apart.
 *
 * Deliberately *not* a combobox: the lists it filters are a `<nav>` of links and
 * a `role="tree"`, both of which keep their own keyboard model. This types,
 * clears, and counts; it never moves the selection.
 */
export function FilterBox({
  value,
  onChange,
  label,
  placeholder,
  count,
  controls,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name. Visible only as the placeholder. */
  label: string;
  placeholder: string;
  /** Rows showing now, or null when nothing is filtered. */
  count: number | null;
  /** Id of the list being filtered. */
  controls?: string;
}) {
  const [announcement, setAnnouncement] = useState('');

  // Same bargain as the palette's own live region: a count announced while it
  // is still changing turns every keystroke into an interruption.
  useEffect(() => {
    if (value.trim().length === 0 || count === null) {
      setAnnouncement('');
      return;
    }

    const timer = setTimeout(() => {
      setAnnouncement(count === 0 ? 'No matches' : `${count} ${count === 1 ? 'match' : 'matches'}`);
    }, ANNOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, count]);

  return (
    <div className="mdv-filter">
      <input
        className="mdv-filter-field"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        aria-controls={controls}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Escape empties the box rather than reaching the panel behind it,
          // which is what every filter field in every file tree does.
          if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            onChange('');
          }
        }}
      />

      {count !== null ? (
        <span className="mdv-filter-count" aria-hidden="true">
          {count}
        </span>
      ) : null}

      {value.length > 0 ? (
        <button
          type="button"
          className="mdv-filter-clear"
          aria-label={`Clear ${label.toLowerCase()}`}
          title="Clear (Escape)"
          onClick={() => onChange('')}
        >
          <ClearIcon />
        </button>
      ) : null}

      <div className="mdv-filter-live" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

/** Inline, because the extension never loads a resource of any kind. */
function ClearIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}
