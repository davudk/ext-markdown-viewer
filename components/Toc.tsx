import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';

import { createMatcher, type FuzzyField } from '@/lib/commands';
import { FILTER_RESULT_LIMIT } from '@/lib/config';
import type { Heading } from '@/lib/markdown';

import { FilterBox, useFuzzy } from './CommandPalette';

import './toc.css';

/**
 * Distance below the viewport top at which a heading is considered "current".
 * Roughly the gap a heading sits in once you have scrolled it into place — far
 * enough down that a heading only takes over after you have actually arrived at
 * it, not the instant its first pixel appears.
 *
 * Local rather than in `lib/config.ts`: it is a property of this outline's feel,
 * not a value any other module has an opinion about.
 */
const ACTIVE_LINE_PX = 96;

/** Where a clicked heading is parked — above ACTIVE_LINE_PX, so the jump lands already active. */
const JUMP_OFFSET_PX = 24;

/**
 * How close to the end of the document the last heading takes over, as a
 * fraction of the viewport. See `useActiveHeading` for why this exists at all.
 */
const END_ZONE_RATIO = 0.25;

/** How long after the reader touches the outline we stop moving it for them. */
const QUIET_MS = 1200;

interface TocNode {
  heading: Heading;
  children: TocNode[];
}

/**
 * What the filter box matches on.
 *
 * The heading text and nothing else. A level is not something anyone types, and
 * the ancestor path is deliberately absent: matching a parent's name would
 * return every heading under it, which is the opposite of narrowing.
 */
const FILTER_FIELDS: readonly FuzzyField[] = [{ name: 'title', weight: 1 }];

/**
 * The outline panel: the document's headings, scroll-spy, and jump-to-heading.
 *
 * A panel rather than a sidebar — `Sidebar.tsx` owns the `<nav>`, the collapse
 * toggle and the tab strip, and this renders inside one tab of it. Everything
 * that is about *headings* stayed here; everything that was about *the sidebar*
 * moved out. The one thing that crossed the line is `visible`: the follow-the-
 * active-entry scroll below has to know whether anyone can see it, which used
 * to be the local `expanded` state and is now a prop. It defaults to true, so
 * an outline rendered anywhere other than behind a tab needs no ceremony.
 *
 * Headings arrive flat and already slugged (see `lib/markdown.ts`) — the ids
 * here are the same ones on the `<h1>`–`<h4>` in the document body, which is
 * what lets every link be a real `#fragment` that survives copy, middle-click
 * and bookmarking.
 */
export function Toc({
  headings,
  visible = true,
}: {
  headings: Heading[];
  visible?: boolean;
}) {
  const activeId = useActiveHeading(headings);

  const tree = useMemo(() => buildTree(headings), [headings]);

  const [filter, setFilter] = useState('');
  const fuse = useFuzzy();
  const listId = useId();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const linksRef = useRef(new Map<string, HTMLAnchorElement>());
  // Timestamp until which the outline is the reader's to scroll, not ours.
  const quietUntilRef = useRef(0);

  /**
   * Matching runs over a flat projection, and a match returns the heading.
   *
   * Flat rather than over the tree because a filtered outline is not an outline:
   * showing an `h3` under an `h2` that did not match would be showing a row
   * nobody asked for, and hiding it would make the match unreachable. The tree
   * comes back the moment the box is empty.
   */
  const searchable = useMemo(
    () => headings.map((heading) => ({ title: heading.text, heading })),
    [headings],
  );

  const match = useMemo(
    () => createMatcher(searchable, FILTER_FIELDS, fuse, FILTER_RESULT_LIMIT),
    [searchable, fuse],
  );

  /** Null while the box is empty, which is what selects the tree over the list. */
  const matched = useMemo(() => {
    const query = filter.trim();
    if (query.length === 0) return null;
    return match(query).map((result) => result.item.heading);
  }, [match, filter]);

  const hush = useCallback(() => {
    quietUntilRef.current = Date.now() + QUIET_MS;
  }, []);

  // Follow the active entry, but never while the reader is working the list
  // themselves — nothing feels worse than a list that scrolls out from under
  // the pointer mid-drag.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const link = activeId ? linksRef.current.get(activeId) : undefined;
    if (!scroller || !link || !visible) return;
    if (Date.now() < quietUntilRef.current) return;
    // While filtering, the list belongs to whoever is typing. Scrolling it to
    // where the reader happens to be in the document would move the answer they
    // are narrowing towards out from under them.
    if (matched !== null) return;

    const pad = 32;
    const viewTop = scroller.scrollTop;
    const viewBottom = viewTop + scroller.clientHeight;
    let next = viewTop;

    if (link.offsetTop < viewTop + pad) {
      next = link.offsetTop - pad;
    } else if (link.offsetTop + link.offsetHeight > viewBottom - pad) {
      next = link.offsetTop + link.offsetHeight - scroller.clientHeight + pad;
    } else {
      return;
    }

    scroller.scrollTo({
      top: Math.max(0, next),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });
  }, [activeId, visible, matched]);

  const navigate = useCallback((event: MouseEvent<HTMLAnchorElement>, id: string) => {
    // Modified clicks belong to the browser: new tab, new window, download.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = document.getElementById(id);
    if (!target) return;

    event.preventDefault();
    hush();

    const top = target.getBoundingClientRect().top + window.scrollY - JUMP_OFFSET_PX;
    // `scrollIntoView`/`scrollTo` with an explicit behavior overrides the
    // `scroll-behavior: auto !important` viewer.css applies under reduced
    // motion, so the preference has to be honoured here too.
    window.scrollTo({
      top: Math.max(0, top),
      behavior: reducedMotion() ? 'auto' : 'smooth',
    });

    // pushState rather than assigning `location.hash`: the assignment performs
    // an instant fragment navigation that cancels the smooth scroll. This keeps
    // the URL shareable and Back working without racing the scroll — and it
    // only ever runs on a click, so the browser's own on-load hash handling is
    // left completely alone.
    history.pushState(null, '', `#${id}`);
  }, [hush]);

  // Blank where the panel used to simply not exist. A tab that opens onto
  // nothing looks broken in a way an empty document never did.
  if (headings.length === 0) {
    return <p className="mdv-side-empty">This document has no headings.</p>;
  }

  return (
    <>
      <FilterBox
        value={filter}
        onChange={setFilter}
        label="Filter outline"
        placeholder="Filter headings"
        count={matched?.length ?? null}
        controls={listId}
      />

      <div
        className="mdv-side-scroll"
        ref={scrollerRef}
        onWheel={hush}
        onPointerDown={hush}
        onTouchMove={hush}
        onKeyDown={hush}
      >
        {matched === null ? (
          <TocList
            id={listId}
            nodes={tree}
            activeId={activeId}
            links={linksRef.current}
            onNavigate={navigate}
          />
        ) : matched.length === 0 ? (
          <p className="mdv-side-empty">No headings match that.</p>
        ) : (
          <ul className="mdv-toc-list" id={listId}>
            {matched.map((heading) => (
              <li key={heading.id}>
                <TocLink
                  heading={heading}
                  activeId={activeId}
                  links={linksRef.current}
                  onNavigate={navigate}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * One entry. Extracted so the tree and the filtered list render the same link —
 * the indent, the ref registration and the active marking all have to match, or
 * clearing the filter would visibly change rows that did not change.
 */
function TocLink({
  heading,
  activeId,
  links,
  onNavigate,
}: {
  heading: Heading;
  activeId: string | null;
  links: Map<string, HTMLAnchorElement>;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  return (
    <a
      className="mdv-toc-link"
      href={`#${heading.id}`}
      data-level={heading.level}
      aria-current={heading.id === activeId ? 'location' : undefined}
      ref={(node) => {
        if (node) links.set(heading.id, node);
        return () => {
          links.delete(heading.id);
        };
      }}
      onClick={(event) => onNavigate(event, heading.id)}
    >
      {heading.text}
    </a>
  );
}

function TocList({
  id,
  nodes,
  activeId,
  links,
  onNavigate,
}: {
  id?: string;
  nodes: TocNode[];
  activeId: string | null;
  links: Map<string, HTMLAnchorElement>;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  return (
    <ul className="mdv-toc-list" id={id}>
      {nodes.map(({ heading, children }) => (
        <li key={heading.id}>
          <TocLink
            heading={heading}
            activeId={activeId}
            links={links}
            onNavigate={onNavigate}
          />

          {children.length > 0 ? (
            <TocList
              nodes={children}
              activeId={activeId}
              links={links}
              onNavigate={onNavigate}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The flat outline as a tree.
 *
 * Real documents skip levels (h1 straight to h3) and often start at h2, so the
 * nesting is derived from a stack rather than from the level number itself: a
 * heading hangs off the nearest preceding heading that is shallower than it,
 * and becomes a root when there is none. That keeps every heading — dropping
 * one would leave a section of the document unreachable from the sidebar.
 */
function buildTree(headings: Heading[]): TocNode[] {
  const roots: TocNode[] = [];
  const ancestors: TocNode[] = [];

  for (const heading of headings) {
    const node: TocNode = { heading, children: [] };

    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].heading.level >= heading.level
    ) {
      ancestors.pop();
    }

    (ancestors[ancestors.length - 1]?.children ?? roots).push(node);
    ancestors.push(node);
  }

  return roots;
}

/**
 * Which heading the reader is currently under.
 *
 * The rule is *the last heading whose top has passed the activation line*, not
 * the first one intersecting the viewport. With a screenful of short sections
 * those two disagree constantly: the first intersecting heading is the one you
 * are scrolling *towards*, while the text actually under your eyes belongs to
 * the last one you scrolled *past*. Highlighting the former makes the sidebar
 * run a section ahead of the reader.
 *
 * Two observers, no scroll handler:
 *
 * - `spy` shrinks the root down to the activation line, so a heading crossing
 *   that line is exactly what produces a callback. `boundingClientRect.top <
 *   rootBounds.top` is then a fresh, precise "has passed" for every entry, and
 *   because the first callback reports every observed element the passed-set is
 *   complete from the start rather than filling in as you scroll.
 *
 * - `endStop` exists because the last heading usually *cannot* reach the line:
 *   once the document bottom hits the viewport bottom, scrolling stops, and a
 *   short trailing section leaves the final heading stranded halfway down the
 *   screen. It watches the document element against a root parked just below
 *   the viewport, which fires as the end of the document comes into range — the
 *   one moment near the bottom that produces no heading crossing at all.
 *
 * Above the first heading nothing has passed the line; the first entry is
 * highlighted anyway, since the reader is in its section by any reading that
 * matters and a sidebar with nothing lit looks broken.
 *
 * Runs whether or not the outline tab is showing. The observers are idle unless
 * the page moves, and keeping them attached means switching back to the outline
 * shows where the reader is now rather than where they were when they left.
 */
function useActiveHeading(headings: Heading[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (headings.length === 0) return;

    const ids = headings.map((heading) => heading.id);
    const passed = new Set<string>();

    const resolve = () => {
      if (atEnd()) {
        setActiveId(ids[ids.length - 1]);
        return;
      }

      let current = ids[0];
      for (const id of ids) {
        if (passed.has(id)) current = id;
      }
      setActiveId(current);
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
        resolve();
      },
      { rootMargin: `-${ACTIVE_LINE_PX}px 0px 0px 0px` },
    );

    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) spy.observe(element);
    }

    // The margins push the root a little past the bottom of the viewport, so
    // the document element stops intersecting it shortly before the scroll
    // bottoms out. Only the *timing* of the callback comes from the geometry —
    // the decision is made from scroll metrics in `atEnd`, so a browser that
    // clamps the over-100% margin merely fires later, never wrongly.
    const endStop = new IntersectionObserver(resolve, {
      rootMargin: `-${100 + END_ZONE_RATIO * 100}% 0px ${END_ZONE_RATIO * 100 + 10}% 0px`,
    });
    endStop.observe(document.documentElement);

    return () => {
      spy.disconnect();
      endStop.disconnect();
    };
  }, [headings]);

  return activeId;
}

/** True once scrolling can no longer bring another heading up to the line. */
function atEnd(): boolean {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) return false;

  // Half the remaining travel on a document barely taller than the window,
  // where a quarter-viewport zone would cover the whole scroll range.
  const zone = Math.min(window.innerHeight * END_ZONE_RATIO, max / 2);
  return window.scrollY >= max - zone - 1;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
