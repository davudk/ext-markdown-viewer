/**
 * Guards on lib/commands.ts: the registry, the matcher, and the folder store.
 *
 * Two properties here are worth more than the rest and are tested hardest.
 *
 * The first is that a command exists only when it can run. A palette that lists
 * "Export as Word" while the export add-on is unreachable is worse than one that
 * lists nothing — the reader commits a keystroke to it and gets an error, or
 * silence. Every capability is therefore checked in both directions: present
 * when supplied, gone when not.
 *
 * The second is that the substring fallback is a real matcher. It is what every
 * surface uses until Fuse resolves, and on a page where Fuse never resolves it
 * is what they use forever, so its ranking is asserted rather than assumed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCommands,
  buildFileItems,
  buildHeadingItems,
  buildSettingItems,
  createMatcher,
  loadFuse,
  substringMatch,
  PALETTE_FIELDS,
  type CommandContext,
  type PaletteItem,
} from '../lib/commands.ts';
import {
  DEFAULT_SETTINGS,
  FONT_SIZE_RANGE,
  PALETTE_COMMANDS,
  PALETTE_SETTINGS,
  PALETTE_SOURCES,
  PALETTE_SOURCE_ORDER,
  THEME_OPTIONS,
  type Settings,
} from '../lib/config.ts';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** A context with every capability present, so absence is always deliberate. */
function fullContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    settings: { ...DEFAULT_SETTINGS },
    applySettings: () => {},
    toggleRaw: () => {},
    showRaw: false,
    exportFormats: ['html', 'docx'],
    exportAs: () => {},
    print: () => {},
    openFolder: () => {},
    compareFiles: () => {},
    openSettings: () => {},
    ...overrides,
  };
}

const idsOf = (items: PaletteItem[]) => items.map((item) => item.id);

/* -------------------------------------------------------------------------- */
/* Config shape                                                                */
/* -------------------------------------------------------------------------- */

test('every source has a label and a place in the order', () => {
  const labelled = Object.keys(PALETTE_SOURCES).sort();
  assert.deepEqual([...PALETTE_SOURCE_ORDER].sort(), labelled);
});

test('command ids are unique', () => {
  const ids = PALETTE_COMMANDS.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every palette setting names a real setting', () => {
  for (const setting of PALETTE_SETTINGS) {
    assert.ok(setting.key in DEFAULT_SETTINGS, `${setting.key} is not a setting`);
  }
});

test('a cycled setting lists its own default among its options', () => {
  // Without this a fresh install would show "Now default — switch to Solarized"
  // on a row whose value is not in the list, and the first press would jump.
  for (const setting of PALETTE_SETTINGS) {
    if (!setting.options) continue;
    const current = String(DEFAULT_SETTINGS[setting.key]);
    assert.ok(
      setting.options.some((option) => option.value === current),
      `${setting.key} default ${current} is not one of its options`,
    );
  }
});

test('an uncycled setting is a boolean', () => {
  for (const setting of PALETTE_SETTINGS) {
    if (setting.options) continue;
    assert.equal(
      typeof DEFAULT_SETTINGS[setting.key],
      'boolean',
      `${setting.key} has no options but is not on/off`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Which commands exist                                                        */
/* -------------------------------------------------------------------------- */

test('a fully-capable shell reaches every declared command', () => {
  // fontSize sits mid-range so both size commands are in play.
  const context = fullContext({
    settings: { ...DEFAULT_SETTINGS, fontSize: 16 },
  });
  const built = idsOf(buildCommands(context));

  for (const command of PALETTE_COMMANDS) {
    assert.ok(
      built.includes(`command:${command.id}`),
      `${command.id} is declared but unreachable`,
    );
  }
});

test('export is absent when no format can be produced', () => {
  const none = idsOf(buildCommands(fullContext({ exportFormats: [] })));
  assert.ok(!none.includes('command:export-html'));
  assert.ok(!none.includes('command:export-docx'));

  // The add-on managed HTML but not Word: one row, not two, and not zero.
  const partial = idsOf(buildCommands(fullContext({ exportFormats: ['html'] })));
  assert.ok(partial.includes('command:export-html'));
  assert.ok(!partial.includes('command:export-docx'));
});

test('export is absent when the shell cannot run one', () => {
  const built = idsOf(buildCommands(fullContext({ exportAs: undefined })));
  assert.ok(!built.includes('command:export-html'));
  assert.ok(!built.includes('command:export-docx'));
});

test('capabilities the shell withheld leave no row behind', () => {
  const cases: [keyof CommandContext, string][] = [
    ['toggleRaw', 'command:toggle-raw'],
    ['print', 'command:print'],
    ['openFolder', 'command:open-folder'],
    ['compareFiles', 'command:compare-files'],
    ['openSettings', 'command:open-settings'],
  ];

  for (const [capability, id] of cases) {
    const built = idsOf(buildCommands(fullContext({ [capability]: undefined })));
    assert.ok(!built.includes(id), `${id} survived a missing ${capability}`);
  }
});

test('text size stops offering a step it cannot take', () => {
  const atMax = idsOf(
    buildCommands(fullContext({ settings: { ...DEFAULT_SETTINGS, fontSize: FONT_SIZE_RANGE.max } })),
  );
  assert.ok(!atMax.includes('command:text-larger'));
  assert.ok(atMax.includes('command:text-smaller'));

  const atMin = idsOf(
    buildCommands(fullContext({ settings: { ...DEFAULT_SETTINGS, fontSize: FONT_SIZE_RANGE.min } })),
  );
  assert.ok(atMin.includes('command:text-larger'));
  assert.ok(!atMin.includes('command:text-smaller'));
});

test('every command row is a command, and ids do not collide', () => {
  const items = buildCommands(fullContext());
  for (const item of items) assert.equal(item.source, 'command');
  assert.equal(new Set(idsOf(items)).size, items.length);
});

/* -------------------------------------------------------------------------- */
/* What commands do                                                            */
/* -------------------------------------------------------------------------- */

/** Builds against a recorder and returns the patch a named row writes. */
function runCommand(id: string, settings: Settings): Partial<Settings> {
  const patches: Partial<Settings>[] = [];
  const items = buildCommands(
    fullContext({ settings, applySettings: (patch) => patches.push(patch) }),
  );
  const item = items.find((candidate) => candidate.id === `command:${id}`);
  assert.ok(item, `${id} was not built`);
  item.run();
  return patches[0] ?? {};
}

test('toggling the theme walks the options and wraps', () => {
  let theme = DEFAULT_SETTINGS.theme;
  const seen: string[] = [];

  for (let step = 0; step < THEME_OPTIONS.length + 1; step += 1) {
    const patch = runCommand('toggle-theme', { ...DEFAULT_SETTINGS, theme });
    theme = patch.theme as Settings['theme'];
    seen.push(theme);
  }

  // One full lap plus one step: the last entry is back where the first was.
  assert.equal(new Set(seen.slice(0, THEME_OPTIONS.length)).size, THEME_OPTIONS.length);
  assert.equal(seen[THEME_OPTIONS.length], seen[0]);
});

test('toggling the sidebar and auto-refresh flips them', () => {
  assert.deepEqual(runCommand('toggle-toc', { ...DEFAULT_SETTINGS, showToc: true }), {
    showToc: false,
  });
  assert.deepEqual(runCommand('toggle-live-reload', { ...DEFAULT_SETTINGS, liveReload: false }), {
    liveReload: true,
  });
});

test('text size steps stay inside the range', () => {
  const nearMax = FONT_SIZE_RANGE.max - 1;
  assert.deepEqual(runCommand('text-larger', { ...DEFAULT_SETTINGS, fontSize: nearMax }), {
    fontSize: FONT_SIZE_RANGE.max,
  });

  const nearMin = FONT_SIZE_RANGE.min + 1;
  assert.deepEqual(runCommand('text-smaller', { ...DEFAULT_SETTINGS, fontSize: nearMin }), {
    fontSize: FONT_SIZE_RANGE.min,
  });
});

test('a shell capability is called, not reinterpreted', () => {
  let raw = 0;
  let compared = 0;
  const formats: string[] = [];

  const items = buildCommands(
    fullContext({
      toggleRaw: () => {
        raw += 1;
      },
      compareFiles: () => {
        compared += 1;
      },
      exportAs: (format) => formats.push(format),
    }),
  );

  const run = (id: string) => items.find((item) => item.id === `command:${id}`)?.run();
  run('toggle-raw');
  run('compare-files');
  run('export-docx');

  assert.equal(raw, 1);
  assert.equal(compared, 1);
  assert.deepEqual(formats, ['docx']);
});

/* -------------------------------------------------------------------------- */
/* Settings rows                                                               */
/* -------------------------------------------------------------------------- */

test('every setting gets exactly one row, and every row acts', () => {
  const patches: Partial<Settings>[] = [];
  const items = buildSettingItems({ ...DEFAULT_SETTINGS }, (patch) => patches.push(patch));

  assert.equal(items.length, PALETTE_SETTINGS.length);
  assert.equal(new Set(idsOf(items)).size, items.length);

  for (const item of items) {
    assert.equal(item.source, 'setting');
    patches.length = 0;
    item.run();
    assert.equal(patches.length, 1, `${item.id} wrote nothing`);

    // The rule the palette is consistent about: choosing a Setting row changes
    // the setting. A patch equal to the current value would be a row that
    // looks like it did something and did not.
    const [key, value] = Object.entries(patches[0])[0];
    assert.notDeepEqual(
      value,
      DEFAULT_SETTINGS[key as keyof Settings],
      `${item.id} wrote the value it already had`,
    );
  }
});

test('a cycled setting wraps back to where it started', () => {
  const setting = PALETTE_SETTINGS.find((entry) => entry.options);
  assert.ok(setting?.options);

  let value = String(DEFAULT_SETTINGS[setting.key]);
  for (let step = 0; step < setting.options.length; step += 1) {
    const patches: Partial<Settings>[] = [];
    const items = buildSettingItems(
      { ...DEFAULT_SETTINGS, [setting.key]: value } as Settings,
      (patch) => patches.push(patch),
    );
    items.find((item) => item.id === `setting:${setting.key}`)?.run();
    value = String(Object.values(patches[0])[0]);
  }

  assert.equal(value, String(DEFAULT_SETTINGS[setting.key]));
});

test('setting rows cannot collide with command rows', () => {
  const commands = new Set(idsOf(buildCommands(fullContext())));
  for (const item of buildSettingItems({ ...DEFAULT_SETTINGS }, () => {})) {
    assert.ok(!commands.has(item.id), `${item.id} is claimed twice`);
  }
});

/* -------------------------------------------------------------------------- */
/* Headings and files                                                          */
/* -------------------------------------------------------------------------- */

test('headings become rows that hand back their own id', () => {
  const visited: string[] = [];
  const items = buildHeadingItems(
    [
      { id: 'setup', text: 'Setup', level: 2 },
      { id: 'usage', text: 'Usage', level: 2 },
    ],
    (id) => visited.push(id),
  );

  assert.deepEqual(idsOf(items), ['heading:setup', 'heading:usage']);
  items[1].run();
  assert.deepEqual(visited, ['usage']);
});

test('files become rows that hand back the file', () => {
  const opened: string[] = [];
  const items = buildFileItems(
    [{ id: 'docs/a.md', name: 'a.md', detail: 'docs' }],
    (file) => opened.push(file.id),
  );

  assert.equal(items[0].source, 'file');
  items[0].run();
  assert.deepEqual(opened, ['docs/a.md']);
});

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

const ROWS = [
  { title: 'Print', keywords: 'pdf paper printer', detail: '' },
  { title: 'Export as HTML', keywords: 'save download file', detail: '' },
  { title: 'Export as Word', keywords: 'docx save download', detail: '' },
  { title: 'Printing the handout', keywords: '', detail: 'Level 2' },
  { title: 'settings.md', keywords: '', detail: 'docs/reference' },
];

const titles = (matches: { item: { title: string } }[]) =>
  matches.map((match) => match.item.title);

test('an empty query matches nothing at all', () => {
  assert.deepEqual(substringMatch(ROWS, ''), []);
  assert.deepEqual(substringMatch(ROWS, '   '), []);
});

test('a query that appears nowhere returns nothing', () => {
  assert.deepEqual(substringMatch(ROWS, 'kubernetes'), []);
});

test('the exact title outranks a longer one containing it', () => {
  assert.equal(titles(substringMatch(ROWS, 'print'))[0], 'Print');
});

test('a title hit outranks a keyword hit', () => {
  // "Print" has it in the title; "Export as Word" only in its keywords.
  const ranked = titles(substringMatch(ROWS, 'p'));
  assert.equal(ranked[0], 'Print');
});

test('matching ignores case', () => {
  assert.deepEqual(titles(substringMatch(ROWS, 'PRINT')), titles(substringMatch(ROWS, 'print')));
});

test('every word has to match, in any field and any order', () => {
  assert.deepEqual(titles(substringMatch(ROWS, 'export docx')), ['Export as Word']);
  assert.deepEqual(titles(substringMatch(ROWS, 'docx export')), ['Export as Word']);
  assert.deepEqual(substringMatch(ROWS, 'export kubernetes'), []);
});

test('a word starting mid-path still matches, and ranks below a name', () => {
  const ranked = titles(substringMatch(ROWS, 'reference'));
  assert.deepEqual(ranked, ['settings.md']);
});

test('the fallback matcher honours its limit', () => {
  const match = createMatcher(ROWS, PALETTE_FIELDS, null, 2);
  assert.equal(match('e').length <= 2, true);
});

test('the fallback matcher returns nothing for an empty query', () => {
  const match = createMatcher(ROWS, PALETTE_FIELDS, null, 10);
  assert.deepEqual(match(''), []);
});

/* -------------------------------------------------------------------------- */
/* Fuse                                                                        */
/* -------------------------------------------------------------------------- */

test('Fuse loads, and loads once', async () => {
  const first = await loadFuse();
  const second = await loadFuse();

  // A null here is a legitimate outcome in a browser that refused the module,
  // but not in node — the dependency is pinned and present, so a null means the
  // import specifier is wrong rather than that the fallback is working.
  assert.ok(first, 'fuse.js did not load');
  assert.equal(first, second, 'fuse.js was resolved twice');
});

test('Fuse forgives a typo the substring matcher cannot', async () => {
  const fuse = await loadFuse();
  assert.ok(fuse);

  const fuzzy = createMatcher(ROWS, PALETTE_FIELDS, fuse, 10);
  const exact = createMatcher(ROWS, PALETTE_FIELDS, null, 10);

  // One transposed character: the whole reason Fuse is here.
  assert.deepEqual(exact('exprot'), []);
  assert.ok(fuzzy('exprot').length > 0, 'fuzzy matching found nothing for a typo');
});

test('both matchers agree on an exact query', async () => {
  const fuse = await loadFuse();
  assert.ok(fuse);

  assert.equal(titles(createMatcher(ROWS, PALETTE_FIELDS, fuse, 10)('print'))[0], 'Print');
  assert.equal(titles(createMatcher(ROWS, PALETTE_FIELDS, null, 10)('print'))[0], 'Print');
});
