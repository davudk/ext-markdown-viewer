/**
 * The React hooks the viewer shell still composes.
 *
 * There were three: scroll memory, keyboard shortcuts and live reload. The
 * first and last are now plugins — `plugins/scroll-memory/` and
 * `plugins/live-reload/`, the latter polling through `lib/live-reload.ts`,
 * which is where the extension's one `fetch` lives. Neither was ever really a
 * hook: both were side-effect plumbing that happened to need a component to
 * hang off, and a plugin gives them a lifecycle of their own.
 *
 * What is left is genuinely the shell's: the global key table, bound once for
 * the page. It degrades to doing nothing, as it always did — a document that
 * cannot respond to `t` is still a document.
 */

import { useEffect, useRef } from 'react';

import { SHORTCUTS } from './config.ts';

export interface ShortcutHandlers {
  toggleToc?: () => void;
  toggleRaw?: () => void;
  cycleTheme?: () => void;
}

const ACTION_BY_KEY = new Map<string, keyof ShortcutHandlers>(
  Object.entries(SHORTCUTS).map(([action, key]) => [
    key,
    action as keyof ShortcutHandlers,
  ]),
);

/**
 * Whether a keystroke belongs to whatever the user is typing into. The raw view
 * and the search field a future version adds are both plain form controls, and
 * a bare `t` that toggles the sidebar mid-word is a bug, not a shortcut.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['input', 'textarea', 'select'].includes(
    target.tagName.toLowerCase(),
  );
}

/** Binds `SHORTCUTS`. Handlers may change between renders; the listener does not. */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Anything with a modifier belongs to the browser or the OS — Ctrl-D is a
      // bookmark, Cmd-R is a reload, and shadowing either would be hostile.
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.defaultPrevented || event.isComposing) return;
      if (isTypingTarget(event.target)) return;

      const action = ACTION_BY_KEY.get(event.key.toLowerCase());
      const handler = action && latest.current[action];
      if (!handler) return;

      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
