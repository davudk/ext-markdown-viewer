/**
 * What the command palette and the two sidebar filter boxes are made of: the
 * item shape they all share, the matcher they all use, and the registry that
 * turns `PALETTE_COMMANDS` into things that can actually be run.
 *
 * Deliberately free of React and of the DOM, so every rule below — which
 * commands exist, how a query is ranked, what a setting row does when it is
 * chosen — is testable in bare node, with no exceptions left: the folder
 * registry that used to sit at the bottom is a capability now.
 *
 * The other rule this file exists to enforce is the boundary on Fuse.js: it
 * matches *discrete items* — commands, headings, filenames, settings — and it
 * is never used on the text of a document. In-document search is a different
 * problem with a different implementation, and mixing the two would put a
 * fuzzy matcher between a reader and a literal string they typed.
 */

import type { IFuseOptions } from 'fuse.js';

import {
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_RANGE,
  FUZZY_OPTIONS,
  PALETTE_COMMANDS,
  PALETTE_SETTINGS,
  THEME_OPTIONS,
  type ExportFormat,
  type PaletteCommandId,
  type PaletteSetting,
  type PaletteSource,
  type Settings,
} from './config.ts';
import type { Heading } from './markdown.ts';

/* -------------------------------------------------------------------------- */
/* Items                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row, whatever it came from.
 *
 * `source` is not decoration — it is the difference between jumping to a
 * heading called "Export" and running the command called "Export as HTML", and
 * the palette prints it on every row for exactly that reason.
 */
export interface PaletteItem {
  /** Unique across every source; also the DOM id of the row. */
  id: string;
  source: PaletteSource;
  title: string;
  /** The second, quieter line: a file's folder, a setting's current value. */
  detail?: string;
  /** Matched but never shown. */
  keywords?: string;
  /** Right-aligned: a current value, or the key that does the same thing. */
  hint?: string;
  run: () => void;
}

/** A file the palette can offer: one in the open folder, or one read before. */
export interface PaletteFile {
  /** Path inside the open folder, or the document's address. Unique. */
  id: string;
  name: string;
  /** Where it is — the folder path above it, or a shortened address. */
  detail: string;
}

/** Fields the matcher reads, and how much each one counts. */
export interface FuzzyField {
  name: string;
  /** 1 is "this is the thing you typed"; lower is context. */
  weight: number;
}

/**
 * What a palette row is matched on.
 *
 * `detail` is here and weighted low on purpose: typing a folder name should
 * surface the files under it, but never above a file actually called that.
 */
export const PALETTE_FIELDS: readonly FuzzyField[] = [
  { name: 'title', weight: 1 },
  { name: 'keywords', weight: 0.35 },
  { name: 'detail', weight: 0.25 },
];

/* -------------------------------------------------------------------------- */
/* Fuse.js, and what happens when it never arrives                             */
/* -------------------------------------------------------------------------- */

/** The shape `loadFuse` resolves to: Fuse's constructor, or nothing. */
export type FuseConstructor = new <T>(
  list: readonly T[],
  options?: IFuseOptions<T>,
) => { search(query: string): { item: T; score?: number }[] };

let loading: Promise<FuseConstructor | null> | null = null;

/**
 * Fuse, once, or null forever.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ This `import()` does not split. It is still the right call. Read on.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The obvious way to keep a library out of the base bundle here is the add-on
 * path in `ADDONS`: a separate entrypoint injected by `chrome.scripting`, which
 * is how mermaid, KaTeX and export all stay out of `renderer.js`. That works
 * because the service worker injects a *file by name* — nothing resolves a
 * specifier at runtime, so nothing can resolve it against the page's origin.
 *
 * A dynamic `import()` in a content script normally cannot claim that: a bare
 * or relative specifier is resolved against the document, which for a `.md`
 * file on some other host is a request that 404s — and the zero-network rule
 * means it must never be one that succeeds either. What makes it safe here is
 * that the specifier never survives the build. WXT builds unlisted scripts in
 * Vite's library mode with `formats: ['iife']` (see its `getLibModeConfig`),
 * and a single-entry IIFE forces `inlineDynamicImports`, so Rollup resolves
 * this at build time and emits `Promise.resolve().then(…)` over a module that
 * is already in `renderer.js`. Verified against the built output, not assumed.
 *
 * So the honest accounting: this is lazy in *time* — Fuse is not constructed,
 * and its index is not built, until something is actually filtered — but not in
 * bundle size. Moving those ~25 kB out needs an `entrypoints/fuse-addon.ts` and
 * an `ADDONS` entry, which is a change to files this component does not own.
 *
 * Either way the failure is handled rather than fatal: a null here means every
 * surface falls back to `substringMatch`, which is worse at typos and fine at
 * everything else.
 */
export function loadFuse(): Promise<FuseConstructor | null> {
  loading ??= import('fuse.js')
    .then((module) => module.default as unknown as FuseConstructor)
    .catch(() => null);

  return loading;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

export interface Match<T> {
  item: T;
  /** Fuse's convention: 0 is perfect, 1 is the worst thing still shown. */
  score: number;
}

/** Characters a word can start after, so `settings` matches `docs/settings.md`. */
const WORD_EDGE = /[\s/\\._\-:]/;

function textAt(item: object, field: string): string {
  const value = (item as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

/**
 * How well one field answers one word. Null when it does not contain it at all.
 *
 * Three things are graded, in the order a reader would: whether the word starts
 * the field, whether it at least starts a word inside it, and how much of the
 * field the word accounts for — which is what keeps `Print` above
 * `Print the presentation handout` for the query `print`.
 */
function fieldScore(text: string, needle: string): number | null {
  if (text.length === 0) return null;

  const at = text.indexOf(needle);
  if (at < 0) return null;

  const placement = at === 0 ? 0 : WORD_EDGE.test(text[at - 1]) ? 0.15 : 0.3;
  const coverage = 1 - needle.length / text.length;
  return Math.min(1, placement + coverage * 0.5);
}

/**
 * Plain substring matching, used when Fuse is unavailable.
 *
 * Every word in the query has to appear somewhere in the item, in any field and
 * in any order — `exp docx` finds "Export as Word" through its keywords. That
 * is deliberately not a fuzzy match: it makes no guesses, so the results it
 * returns are ones the reader can explain to themselves.
 */
export function substringMatch<T extends object>(
  items: readonly T[],
  query: string,
  fields: readonly FuzzyField[] = PALETTE_FIELDS,
): Match<T>[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const matches: Match<T>[] = [];

  for (const item of items) {
    const texts = fields.map((field) => ({
      text: textAt(item, field.name).toLowerCase(),
      weight: field.weight,
    }));

    let total = 0;
    let matchedEvery = true;

    for (const word of words) {
      let best: number | null = null;

      for (const { text, weight } of texts) {
        const score = fieldScore(text, word);
        if (score === null) continue;
        // A hit in a low-weight field is a worse answer than the same hit in
        // the title, which is the whole purpose of the weights.
        const adjusted = Math.min(1, score * (2 - weight));
        if (best === null || adjusted < best) best = adjusted;
      }

      if (best === null) {
        matchedEvery = false;
        break;
      }
      total += best;
    }

    if (matchedEvery) matches.push({ item, score: total / words.length });
  }

  // Stable, so items that score identically stay in the order they were built
  // in — which is the order `PALETTE_SOURCE_ORDER` and the document put them.
  return matches.sort((a, b) => a.score - b.score);
}

/**
 * A matcher over a fixed list: Fuse's when it loaded, substring's when it did
 * not. Building the Fuse index is the expensive half and happens once per list
 * rather than once per keystroke, which is why this returns a function.
 */
export type Matcher<T> = (query: string) => Match<T>[];

export function createMatcher<T extends object>(
  items: readonly T[],
  fields: readonly FuzzyField[],
  fuse: FuseConstructor | null,
  limit: number,
): Matcher<T> {
  if (!fuse) {
    return (query) => substringMatch(items, query, fields).slice(0, limit);
  }

  const index = new fuse(items, {
    ...(FUZZY_OPTIONS as IFuseOptions<T>),
    keys: fields.map((field) => ({ name: field.name, weight: field.weight })),
  });

  return (query) => {
    if (query.trim().length === 0) return [];
    return index
      .search(query)
      .slice(0, limit)
      .map((result) => ({ item: result.item, score: result.score ?? 0 }));
  };
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the shell is able to do, as opposed to what the palette can reach.
 *
 * Everything optional here is a capability the palette does not own: the raw
 * view is `Viewer`'s state, exporting belongs to an add-on that may not load,
 * the folder picker lives in `FolderBrowser`, and comparing files needs a
 * folder to be open in the first place. Each absent entry removes its command
 * from the list — a palette that offers an action and then does nothing is a
 * worse palette than a shorter one.
 */
export interface CommandContext {
  settings: Settings;
  /** Writes a settings patch. The shell passes `saveSettings`. */
  applySettings: (patch: Partial<Settings>) => void;
  /** Present when the shell can switch between rendered and raw. */
  toggleRaw?: () => void;
  /** Which of the two the reader is looking at, for the hint. */
  showRaw?: boolean;
  /**
   * Formats that can be produced *right now*. Empty when the export add-on
   * could not be injected, which removes both export commands rather than
   * leaving them to fail once the reader has committed to one.
   */
  exportFormats?: readonly ExportFormat[];
  exportAs?: (format: ExportFormat) => void;
  /** Defaults to `window.print` in the component; required here to stay pure. */
  print?: () => void;
  /** Absent where the File System Access API is not available. */
  openFolder?: () => void;
  /** Absent with no folder open — there would be nothing to compare against. */
  compareFiles?: () => void;
  /** Absent unless the shell has a way to reach the options page. */
  openSettings?: () => void;
}

const COMMAND_BY_ID = new Map(
  PALETTE_COMMANDS.map((command) => [command.id as PaletteCommandId, command]),
);

/** Steps through a list of options and wraps, matching the `d` shortcut's feel. */
function nextValue<T extends string>(
  options: ReadonlyArray<{ value: string; label: string }>,
  current: T,
): { value: string; label: string } {
  const at = options.findIndex((option) => option.value === current);
  return options[(at + 1) % options.length];
}

function labelOf(
  options: ReadonlyArray<{ value: string; label: string }>,
  current: string,
): string {
  return options.find((option) => option.value === current)?.label ?? current;
}

const onOff = (on: boolean) => (on ? 'On' : 'Off');

/**
 * Every command that can actually run, in the order `PALETTE_COMMANDS` declares.
 *
 * The two halves of a command meet here and nowhere else: the description comes
 * from `lib/config.ts`, the ability comes from `context`, and an id with no
 * ability behind it is simply skipped.
 */
export function buildCommands(context: CommandContext): PaletteItem[] {
  const { settings, applySettings } = context;
  const items: PaletteItem[] = [];

  const add = (id: PaletteCommandId, hint: string | undefined, run: () => void) => {
    const command = COMMAND_BY_ID.get(id);
    if (!command) return;
    items.push({
      id: `command:${id}`,
      source: 'command',
      title: command.title,
      keywords: command.keywords,
      hint,
      run,
    });
  };

  add('toggle-theme', labelOf(THEME_OPTIONS, settings.theme), () => {
    applySettings({
      theme: nextValue(THEME_OPTIONS, settings.theme).value as Settings['theme'],
    });
  });

  add('toggle-toc', onOff(settings.showToc), () => {
    applySettings({ showToc: !settings.showToc });
  });

  if (context.toggleRaw) {
    const toggleRaw = context.toggleRaw;
    add('toggle-raw', context.showRaw ? 'Raw' : 'Rendered', toggleRaw);
  }

  const formats = context.exportFormats ?? [];
  const exportAs = context.exportAs;
  if (exportAs) {
    if (formats.includes('html')) add('export-html', undefined, () => exportAs('html'));
    if (formats.includes('docx')) add('export-docx', undefined, () => exportAs('docx'));
  }

  if (context.print) {
    const print = context.print;
    add('print', undefined, print);
  }

  if (context.openFolder) {
    const openFolder = context.openFolder;
    add('open-folder', undefined, openFolder);
  }

  if (context.compareFiles) {
    const compareFiles = context.compareFiles;
    add('compare-files', undefined, compareFiles);
  }

  add('change-font', labelOf(FONT_FAMILY_OPTIONS, settings.fontFamily), () => {
    applySettings({
      fontFamily: nextValue(FONT_FAMILY_OPTIONS, settings.fontFamily)
        .value as Settings['fontFamily'],
    });
  });

  // Absent at the ends of the range for the same reason a missing capability
  // is: a row that changes nothing when chosen is noise in a list read by
  // pressing Enter on the first thing that looks right.
  if (settings.fontSize < FONT_SIZE_RANGE.max) {
    add('text-larger', `${settings.fontSize}px`, () => {
      applySettings({
        fontSize: Math.min(FONT_SIZE_RANGE.max, settings.fontSize + FONT_SIZE_RANGE.step),
      });
    });
  }

  if (settings.fontSize > FONT_SIZE_RANGE.min) {
    add('text-smaller', `${settings.fontSize}px`, () => {
      applySettings({
        fontSize: Math.max(FONT_SIZE_RANGE.min, settings.fontSize - FONT_SIZE_RANGE.step),
      });
    });
  }

  add('toggle-live-reload', onOff(settings.liveReload), () => {
    applySettings({ liveReload: !settings.liveReload });
  });

  if (context.openSettings) {
    const openSettings = context.openSettings;
    add('open-settings', undefined, openSettings);
  }

  return items;
}

/**
 * The settings, as rows that change something.
 *
 * The rule, applied without exception: choosing a Setting row *acts*. A boolean
 * flips, an enumeration advances to its next value, and the hint says what the
 * value is now so the reader can press Enter again to keep going. The
 * alternative — a row that navigates to the options page — was rejected because
 * half the settings would then act and half would navigate, and no row would
 * say which kind it was until it had already done the wrong one. Reaching the
 * options page is the "Open settings…" *command*, which reads as navigation
 * because that is the only thing it does.
 */
export function buildSettingItems(
  settings: Settings,
  applySettings: (patch: Partial<Settings>) => void,
): PaletteItem[] {
  return PALETTE_SETTINGS.map((setting) => toSettingItem(setting, settings, applySettings));
}

function toSettingItem(
  setting: PaletteSetting,
  settings: Settings,
  applySettings: (patch: Partial<Settings>) => void,
): PaletteItem {
  const current = settings[setting.key];

  if (setting.options) {
    const value = String(current);
    const next = nextValue(setting.options, value);
    return {
      id: `setting:${setting.key}`,
      source: 'setting',
      title: setting.label,
      detail: `Now ${labelOf(setting.options, value)} — switch to ${next.label}`,
      keywords: setting.keywords,
      hint: labelOf(setting.options, value),
      run: () => applySettings({ [setting.key]: next.value } as Partial<Settings>),
    };
  }

  const on = current === true;
  return {
    id: `setting:${setting.key}`,
    source: 'setting',
    title: setting.label,
    detail: on ? 'On — turn it off' : 'Off — turn it on',
    keywords: setting.keywords,
    hint: onOff(on),
    run: () => applySettings({ [setting.key]: !on } as Partial<Settings>),
  };
}

/** The outline, as rows. `go` is what the palette does with the id it picks. */
export function buildHeadingItems(
  headings: readonly Heading[],
  go: (id: string) => void,
): PaletteItem[] {
  return headings.map((heading) => ({
    id: `heading:${heading.id}`,
    source: 'heading',
    title: heading.text,
    detail: `Level ${heading.level}`,
    run: () => go(heading.id),
  }));
}

/** Files, as rows. Used for both the open folder and previously read documents. */
export function buildFileItems(
  files: readonly PaletteFile[],
  open: (file: PaletteFile) => void,
): PaletteItem[] {
  return files.map((file) => ({
    id: `file:${file.id}`,
    source: 'file',
    title: file.name,
    detail: file.detail,
    run: () => open(file),
  }));
}

/* -------------------------------------------------------------------------- */
/* Files, as the palette sees them                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the folder browser knows and the palette needs.
 *
 * This used to be a module-scope `let`, a set of listeners and a `publishFolder`
 * function right here — one publisher, one subscriber, and a live handle on a
 * mounted component held at module scope for the life of the page. The reason
 * given was the tree it would otherwise travel: the browser renders two
 * components below the palette's own parent, and neither is ours to edit.
 *
 * That reason is gone. The plugin host has capabilities, which are exactly this
 * — published by whoever owns the thing, read by whoever needs it, typed by
 * declaration merging, and withdrawn when the provider is disabled instead of
 * lingering. The shape moved to `plugins/files/types.ts` as `files.browser`;
 * only the item builders below are left here, and they take what they need.
 */
