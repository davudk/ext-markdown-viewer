/**
 * The table of contents: the page's left column.
 *
 * Two parts, in this order — the general sections one by one, then every plugin
 * under a Plugins heading. Both come from `sections.ts`, which the page body is
 * also rendered from, so the nav and the page cannot disagree about what exists
 * or what order it is in.
 *
 * The scroll-spy is the same rule the outline plugin uses on a document, worked
 * out again here rather than imported: `plugins/outline/` is a plugin, and this
 * page may not reach into one. The rule is worth restating because it is not the
 * obvious one — *the last section whose top has passed the activation line*, not
 * the first one intersecting the viewport. With short cards those disagree
 * constantly, and highlighting the first intersecting one makes the nav run a
 * section ahead of the reader.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';

import { FilterBox } from '@/components/FilterBox';
import { createMatcher, type FuzzyField } from '@/lib/commands';

import {
  GENERAL_SECTIONS,
  PLUGIN_GROUPS,
  pluginSectionId,
  type PluginGroup,
} from './sections';
import type { AnyPlugin } from './plugins';

/**
 * Distance below the top of the scrolling area at which a section becomes the
 * current one. Roughly where a card sits once you have scrolled to it, so a
 * section takes over after you have arrived rather than when its first pixel
 * appears.
 */
const ACTIVE_LINE_PX = 120;

/** Where a clicked section parks: above the line, so the jump lands active. */
const JUMP_OFFSET_PX = 24;

/**
 * How close to the bottom the last section takes over, as a fraction of the
 * viewport. The last card usually cannot reach the activation line — once the
 * page bottom meets the viewport bottom, scrolling stops — so without this the
 * final entry could never highlight.
 */
const END_ZONE_RATIO = 0.25;

/** What the filter matches on: the two strings a plugin actually shows. */
const FILTER_FIELDS: readonly FuzzyField[] = [
  { name: 'name', weight: 2 },
  { name: 'description', weight: 1 },
];

export function Toc({ sectionIds }: { sectionIds: readonly string[] }) {
  const activeId = useActiveSection(sectionIds);
  const [filter, setFilter] = useState('');
  const listId = useId();

  const searchable = useMemo(
    () =>
      PLUGIN_GROUPS.flatMap((group) =>
        group.plugins.map((plugin) => ({
          name: plugin.name,
          description: plugin.description,
          plugin,
        })),
      ),
    [],
  );

  /**
   * Substring matching, deliberately: `useFuzzy` would pull Fuse into this
   * page's bundle through a dynamic import, and thirty-two names are a list you
   * scan rather than one you need scored. The matcher is still the shared one,
   * so "contains" means the same thing here as in the sidebar.
   */
  const match = useMemo(
    () => createMatcher(searchable, FILTER_FIELDS, null, searchable.length),
    [searchable],
  );

  /** Null while the box is empty, which is what restores the grouped list. */
  const matched = useMemo(() => {
    const query = filter.trim();
    if (query.length === 0) return null;
    return match(query).map((result) => result.item.plugin);
  }, [match, filter]);

  return (
    <nav className="toc" aria-label="Settings sections">
      <p className="toc-head" id="toc-general-h">
        General
      </p>
      <ul className="toc-list" aria-labelledby="toc-general-h">
        {GENERAL_SECTIONS.map((section) => (
          <li key={section.id}>
            <TocLink id={section.id} label={section.label} activeId={activeId} />
          </li>
        ))}
      </ul>

      <p className="toc-head" id="toc-plugins-h">
        Plugins
      </p>

      <div className="toc-filter">
        <FilterBox
          value={filter}
          onChange={setFilter}
          label="Filter plugins"
          placeholder="Filter plugins"
          count={matched?.length ?? null}
          controls={listId}
        />
      </div>

      {matched === null ? (
        <div id={listId}>
          {PLUGIN_GROUPS.map((group) => (
            <TocGroup key={group.name} group={group} activeId={activeId} />
          ))}
        </div>
      ) : matched.length === 0 ? (
        <p className="toc-empty" id={listId}>
          No plugin matches that.
        </p>
      ) : (
        <ul className="toc-list" id={listId} aria-labelledby="toc-plugins-h">
          {matched.map((plugin) => (
            <li key={plugin.id}>
              <TocLink
                id={pluginSectionId(plugin.id)}
                label={plugin.name}
                activeId={activeId}
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

function TocGroup({
  group,
  activeId,
}: {
  group: PluginGroup;
  activeId: string | null;
}) {
  const headingId = `toc-group-${group.name.replace(/\W+/g, '-').toLowerCase()}`;

  return (
    <>
      <p className="toc-group" id={headingId}>
        {group.name}
        <span className="toc-group-note">{group.note}</span>
      </p>
      <ul className="toc-list" aria-labelledby={headingId}>
        {group.plugins.map((plugin: AnyPlugin) => (
          <li key={plugin.id}>
            <TocLink
              id={pluginSectionId(plugin.id)}
              label={plugin.name}
              activeId={activeId}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * One entry, and the only thing that moves the page.
 *
 * A real `<a href="#id">`, so it is focusable, follows on Enter, opens in a new
 * tab on a modified click, and can be copied as a link to a section. The click
 * handler only takes over to scroll smoothly and to put focus on the card it
 * landed on — a jump that moves the eye but not the keyboard leaves the next
 * Tab back at the top of the nav.
 */
function TocLink({
  id,
  label,
  activeId,
}: {
  id: string;
  label: string;
  activeId: string | null;
}) {
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = document.getElementById(id);
    if (!target) return;

    event.preventDefault();

    const top = target.getBoundingClientRect().top + window.scrollY - JUMP_OFFSET_PX;
    window.scrollTo({
      top: Math.max(0, top),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });

    // The card carries tabIndex={-1} for exactly this.
    target.focus({ preventScroll: true });

    // replaceState rather than assigning `location.hash`: the assignment
    // performs an instant fragment navigation that cancels the smooth scroll.
    // Replace rather than push, because thirty-eight sections would otherwise
    // fill the history and Back would never leave the page.
    history.replaceState(null, '', `#${id}`);
  };

  return (
    <a
      className="toc-link"
      href={`#${id}`}
      aria-current={id === activeId ? 'true' : undefined}
      onClick={navigate}
    >
      {label}
    </a>
  );
}

/**
 * Which section the reader is currently under.
 *
 * Two observers and no scroll handler:
 *
 * - `spy` shrinks the root down to the activation line, so a card crossing that
 *   line is exactly what produces a callback. The first callback reports every
 *   observed element, so the passed-set is complete from the start rather than
 *   filling in as you scroll.
 *
 * - `endStop` covers the bottom of the page, where scrolling runs out before
 *   the last card can reach the line and no crossing happens at all.
 *
 * Above the first card nothing has passed the line; the first entry highlights
 * anyway, since that is the section the reader is in by any reading that
 * matters and a nav with nothing lit looks broken.
 */
function useActiveSection(ids: readonly string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  // The ids are a stable list for the life of the page, but reading them
  // through a ref keeps the effect from re-attaching on an identity change.
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const key = ids.join(' ');


  useEffect(() => {
    const current = idsRef.current;
    if (current.length === 0) return;

    const passed = new Set<string>();

    const settle = () => {
      if (atEnd()) {
        setActiveId(current[current.length - 1]);
        return;
      }

      let found = current[0];
      for (const id of current) {
        if (passed.has(id)) found = id;
      }
      setActiveId(found);
    };

    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const line = entry.rootBounds?.top ?? ACTIVE_LINE_PX;
          if (entry.boundingClientRect.top < line) {
            passed.add(entry.target.id);
          } else {
            passed.delete(entry.target.id);
          }
        }
        settle();
      },
      { rootMargin: `-${ACTIVE_LINE_PX}px 0px 0px 0px` },
    );

    for (const id of current) {
      const element = document.getElementById(id);
      if (element) spy.observe(element);
    }

    // The margins park the root just past the bottom of the viewport, so this
    // fires as the end of the page comes into range. Only the timing comes from
    // the geometry — the decision is made from scroll metrics in `atEnd`, so a
    // browser that clamps the over-100% margin fires later, never wrongly.
    const endStop = new IntersectionObserver(settle, {
      rootMargin: `-${100 + END_ZONE_RATIO * 100}% 0px ${END_ZONE_RATIO * 100 + 10}% 0px`,
    });
    endStop.observe(document.documentElement);

    return () => {
      spy.disconnect();
      endStop.disconnect();
    };
  }, [key]);

  return activeId;
}

/** True once scrolling can no longer bring another card up to the line. */
function atEnd(): boolean {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) return false;

  // Half the remaining travel on a page barely taller than the window, where a
  // quarter-viewport zone would cover the whole scroll range.
  const zone = Math.min(window.innerHeight * END_ZONE_RATIO, max / 2);
  return window.scrollY >= max - zone - 1;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
