/**
 * Settings as a file.
 *
 * Export is a round trip and little else. Import is the part with teeth: the
 * file arrives from outside the extension, and everything below is a way for it
 * to be wrong — unparseable, unrelated, hand-edited past the ranges the sliders
 * allow, written by a build that does not exist yet, or shaped to make the
 * import write something the extension would never write itself.
 *
 * The invariant every hostile case asserts is the same one: a file that is not
 * fully understood changes nothing. Not "changes less" — nothing.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  CUSTOM_CSS_MAX_LENGTH,
  DEFAULT_SETTINGS,
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  SETTINGS_FILE_FORMAT,
  SETTINGS_FILE_VERSION,
  SETTINGS_KEY,
  type Settings,
} from '../lib/config.ts';
import {
  buildSettingsFile,
  importSettings,
  parseSettingsFile,
  serializeSettings,
  settingsFilename,
  type ImportOk,
  type PluginSchemas,
} from '../lib/settings-io.ts';

/* -------------------------------------------------------------------------- */
/* Fake storage                                                                */
/* -------------------------------------------------------------------------- */

type Data = Record<string, unknown>;

function fakeStorage(): Data {
  const store: Data = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        async get(key: string) {
          return key in store ? { [key]: store[key] } : {};
        },
        async set(items: Data) {
          Object.assign(store, items);
        },
      },
    },
  };
  return store;
}

let data: Data;

beforeEach(() => {
  data = fakeStorage();
});

/** A settings file as text, with `settings` replaced wholesale. */
function file(settings: unknown, overrides: Data = {}): string {
  return JSON.stringify({
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    exportedAt: '2026-07-25T00:00:00.000Z',
    settings,
    ...overrides,
  });
}

function ok(result: ReturnType<typeof parseSettingsFile>): ImportOk {
  assert.ok(result.ok, `expected success, got: ${result.ok ? '' : result.error}`);
  return result;
}

const CUSTOM: Settings = {
  ...DEFAULT_SETTINGS,
  theme: 'dark',
  themePreset: 'gruvbox',
  customCss: 'h1 { letter-spacing: 0; }',
  fontFamily: 'serif',
  fontSize: 19,
  lineHeight: 1.85,
  contentWidth: 'wide',
};

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

test('an exported file carries a format marker and a version', () => {
  // Both are read before anything else on the way back in, so a file without
  // them is not importable and one without them is not exportable.
  const built = buildSettingsFile(CUSTOM);

  assert.equal(built.format, SETTINGS_FILE_FORMAT);
  assert.equal(built.version, SETTINGS_FILE_VERSION);
  assert.match(built.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(built.settings, CUSTOM);
});

test('the file is indented, so it can be read and edited by hand', () => {
  const text = serializeSettings(DEFAULT_SETTINGS);
  assert.ok(text.includes('\n  "format"'));
  assert.ok(text.endsWith('\n'));
});

test('the filename carries the date and sorts usefully', () => {
  assert.equal(
    settingsFilename(new Date(2026, 6, 25)),
    'markdown-viewer-settings-2026-07-25.json',
  );
});

test('a stray key that reached storage is not laundered back out', () => {
  // Settings are read with a spread of the defaults, so an old build's field can
  // survive in storage. The export rebuilds field by field rather than copying.
  const contaminated = { ...CUSTOM, leftoverFromV1: true } as unknown as Settings;
  assert.ok(!Object.hasOwn(buildSettingsFile(contaminated).settings, 'leftoverFromV1'));
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                  */
/* -------------------------------------------------------------------------- */

test('settings survive a round trip unchanged and unremarked', () => {
  const result = ok(parseSettingsFile(serializeSettings(CUSTOM)));

  assert.deepEqual(result.settings, CUSTOM);
  // Nothing was clamped, ignored or missing, so there is nothing to say. A note
  // on a clean import would train the reader to ignore the ones that matter.
  assert.deepEqual(result.notes, []);
  assert.equal(result.fromFuture, false);
});

test('the defaults round trip too', () => {
  // This is what asserts the reader table covers `Settings` exactly: a setting
  // added without a reader would come back as its default and be reported
  // missing, and a reader for a setting that no longer exists would not compile.
  const result = ok(parseSettingsFile(serializeSettings(DEFAULT_SETTINGS)));
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
  assert.deepEqual(result.notes, []);
});

test('importing writes exactly what was validated', async () => {
  const result = await importSettings(serializeSettings(CUSTOM));

  assert.ok(result.ok);
  assert.deepEqual(data[SETTINGS_KEY], CUSTOM);
});

/* -------------------------------------------------------------------------- */
/* Files that are not ours                                                     */
/* -------------------------------------------------------------------------- */

test('malformed JSON fails cleanly', () => {
  for (const text of ['{', '{"format":}', 'not json at all', '{"a":1,}']) {
    const result = parseSettingsFile(text);
    assert.ok(!result.ok, `should have failed: ${text}`);
    assert.match(result.error, /JSON/);
  }
});

test('an empty file fails cleanly', () => {
  assert.ok(!parseSettingsFile('').ok);
  assert.ok(!parseSettingsFile('   \n ').ok);
});

test('JSON that is not an object fails', () => {
  // `null`, an array and a bare number all parse. None of them is a file.
  for (const text of ['null', '[]', '42', '"settings"', '[{"format":"x"}]']) {
    assert.ok(!parseSettingsFile(text).ok, `should have failed: ${text}`);
  }
});

test('an unrelated .json says so, rather than listing missing fields', () => {
  const result = parseSettingsFile('{"name":"package","version":"1.0.0"}');
  assert.ok(!result.ok);
  assert.match(result.error, /isn't a Markdown Viewer settings file/);
});

test('a file with no version, or an absurd one, is refused', () => {
  for (const version of [undefined, null, 0, -1, 1.5, '1', {}]) {
    const text = file(DEFAULT_SETTINGS, { version });
    assert.ok(!parseSettingsFile(text).ok, `should have failed: version ${version}`);
  }
});

test('a file with no settings object is refused', () => {
  for (const settings of [undefined, null, 'dark', 42, ['theme']]) {
    assert.ok(!parseSettingsFile(file(settings)).ok);
  }
});

test('a file far too large to be settings is refused before parsing', () => {
  const huge = file({ ...DEFAULT_SETTINGS, customCss: 'x'.repeat(400_000) });
  const result = parseSettingsFile(huge);
  assert.ok(!result.ok);
  assert.match(result.error, /larger than/);
});

test('a failed import changes nothing', async () => {
  data[SETTINGS_KEY] = { theme: 'dark' };

  for (const text of ['not json', '{"format":"something-else"}', file(null)]) {
    const result = await importSettings(text);
    assert.ok(!result.ok);
  }

  assert.deepEqual(data[SETTINGS_KEY], { theme: 'dark' });
});

/* -------------------------------------------------------------------------- */
/* Fields that are wrong                                                       */
/* -------------------------------------------------------------------------- */

test('wrong types fall back to the default and are reported', () => {
  const result = ok(
    parseSettingsFile(
      file({
        theme: 42,
        fontFamily: null,
        fontSize: 'sixteen',
        lineHeight: 'tall',
        contentWidth: ['wide'],
        themePreset: 'dracula',
      }),
    ),
  );

  assert.equal(result.settings.theme, DEFAULT_SETTINGS.theme);
  assert.equal(result.settings.fontFamily, DEFAULT_SETTINGS.fontFamily);
  assert.equal(result.settings.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.equal(result.settings.lineHeight, DEFAULT_SETTINGS.lineHeight);
  assert.equal(result.settings.contentWidth, DEFAULT_SETTINGS.contentWidth);
  // A preset id from another extension is a string of the right type and still
  // not a preset.
  assert.equal(result.settings.themePreset, DEFAULT_SETTINGS.themePreset);

  assert.ok(result.notes.some((note) => /wrong kind/.test(note)));
});

test('numbers outside their range are clamped, not rejected', () => {
  // A file asking for a 400px body font is out of bounds, not incomprehensible.
  // Reverting it to 16 would be more surprising than landing on the largest
  // size the extension offers.
  const result = ok(
    parseSettingsFile(file({ fontSize: 400, lineHeight: -3 })),
  );

  assert.equal(result.settings.fontSize, FONT_SIZE_RANGE.max);
  assert.equal(result.settings.lineHeight, LINE_HEIGHT_RANGE.min);
  assert.ok(result.notes.some((note) => /allowed range/.test(note)));
});

test('numbers that are not numbers are dropped rather than clamped', () => {
  const result = ok(
    parseSettingsFile(file({ fontSize: Number.NaN, lineHeight: 'tall' })),
  );

  // NaN survives neither JSON nor the reader; it arrives as null.
  assert.equal(result.settings.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.equal(result.settings.lineHeight, DEFAULT_SETTINGS.lineHeight);
});

test('line height keeps the two decimals the range can express', () => {
  const result = ok(parseSettingsFile(file({ lineHeight: 1.7000000000000002 })));
  assert.equal(result.settings.lineHeight, 1.7);
});

test('an oversized stylesheet is capped rather than refused', () => {
  const css = `p { color: red; }`.repeat(3000);
  const result = ok(parseSettingsFile(file({ customCss: css })));

  assert.equal(result.settings.customCss.length, CUSTOM_CSS_MAX_LENGTH);
  assert.ok(result.notes.some((note) => /allowed range/.test(note)));
});

test('a partial file leaves everything else as it was set here', () => {
  const result = ok(parseSettingsFile(file({ theme: 'dark' })));

  assert.equal(result.settings.theme, 'dark');
  assert.equal(result.settings.fontSize, DEFAULT_SETTINGS.fontSize);
  assert.ok(result.notes.some((note) => /Not in the file/.test(note)));
});

/* -------------------------------------------------------------------------- */
/* Keys that are not settings                                                  */
/* -------------------------------------------------------------------------- */

test('unknown keys are reported and never reach settings', () => {
  const result = ok(
    parseSettingsFile(
      file({ theme: 'dark', telemetryEndpoint: 'https://x.example', apiKey: 'sk-1' }),
    ),
  );

  assert.equal(result.settings.theme, 'dark');
  assert.ok(!Object.hasOwn(result.settings, 'telemetryEndpoint'));
  assert.ok(!Object.hasOwn(result.settings, 'apiKey'));
  assert.ok(result.notes.some((note) => /aren't settings/.test(note)));
  // Named, not just counted — "2 entries were ignored" tells the reader nothing
  // about whether the file they were handed was doing something odd.
  assert.ok(result.notes.some((note) => note.includes('telemetryEndpoint')));
});

test('the result has exactly the known keys, whatever the file had', () => {
  const result = ok(parseSettingsFile(file({ extra: 1, another: 2 })));
  assert.deepEqual(
    Object.keys(result.settings).sort(),
    Object.keys(DEFAULT_SETTINGS).sort(),
  );
});

/* -------------------------------------------------------------------------- */
/* Prototype pollution                                                         */
/* -------------------------------------------------------------------------- */

test('a __proto__ key pollutes nothing', () => {
  // `JSON.parse` gives `__proto__` as a plain own property rather than a setter
  // call, so the danger is entirely in what happens next. Spreading or
  // Object.assign-ing the parsed blob is what would turn it into a real
  // prototype write; import reads named fields instead, so there is nothing to
  // defend against — this asserts that stays true.
  const text =
    `{"format":"${SETTINGS_FILE_FORMAT}","version":1,"settings":` +
    `{"__proto__":{"polluted":"yes"},"theme":"dark"}}`;

  const result = ok(parseSettingsFile(text));

  assert.equal(result.settings.theme, 'dark');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(
    (Object.prototype as unknown as Record<string, unknown>).polluted,
    undefined,
  );
  assert.equal(Object.getPrototypeOf(result.settings), Object.prototype);
  assert.ok(!Object.hasOwn(result.settings, 'polluted'));
  assert.ok(result.notes.some((note) => note.includes('__proto__')));
});

test('a constructor.prototype payload pollutes nothing', () => {
  const text =
    `{"format":"${SETTINGS_FILE_FORMAT}","version":1,"settings":` +
    `{"constructor":{"prototype":{"polluted":"yes"}},"prototype":{"polluted":"yes"},` +
    `"theme":"light"}}`;

  const result = ok(parseSettingsFile(text));

  assert.equal(result.settings.theme, 'light');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(
    (Object.prototype as unknown as Record<string, unknown>).polluted,
    undefined,
  );
  // The settings object's own constructor is still Object, not the file's.
  assert.equal(result.settings.constructor, Object);
});

test('a polluted prototype cannot smuggle a setting in', async () => {
  // The other direction, and the one a `key in source` check would fall for:
  // if `Object.prototype.theme` existed, `in` would find it and import would
  // read a setting the file never contained. `Object.hasOwn` does not.
  const proto = Object.prototype as unknown as Record<string, unknown>;
  proto.theme = 'dark';

  try {
    const result = ok(parseSettingsFile(file({ fontSize: 18 })));
    assert.equal(result.settings.theme, DEFAULT_SETTINGS.theme);
  } finally {
    delete proto.theme;
  }
});

/* -------------------------------------------------------------------------- */
/* A file from the future                                                      */
/* -------------------------------------------------------------------------- */

test('a newer file is read as far as it can be, and says so', () => {
  // Refusing it outright would strand anyone moving settings from a machine
  // that updated first — which is exactly the situation export exists for.
  const result = ok(
    parseSettingsFile(
      file(
        { theme: 'dark', fontSize: 18, quantumRendering: true },
        { version: SETTINGS_FILE_VERSION + 5 },
      ),
    ),
  );

  assert.ok(result.fromFuture);
  assert.equal(result.settings.theme, 'dark');
  assert.equal(result.settings.fontSize, 18);
  assert.ok(!Object.hasOwn(result.settings, 'quantumRendering'));
  assert.ok(result.notes.some((note) => /newer version/.test(note)));
  // A future file is expected to disagree about which settings exist, so the
  // "not in the file" note is suppressed rather than listing half of them.
  assert.ok(!result.notes.some((note) => /Not in the file/.test(note)));
});

/* -------------------------------------------------------------------------- */
/* Plugin settings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Two plugins' worth of schema, standing in for the registry.
 *
 * Deliberately hand-written rather than imported from `lib/plugins/index.ts`:
 * the registry reaches JSX and this runner cannot load it, and the point of the
 * schemas being an argument is that import validates whatever it is handed.
 * `quiet` has no settings at all — the case that separates "a plugin this build
 * knows, whose enabled flag may be imported" from one it has never heard of.
 */
const SCHEMAS = {
  outline: {
    depth: { type: 'number', default: 3, min: 1, max: 6, label: 'Depth' },
    label: { type: 'string', default: '', maxLength: 8, label: 'Label' },
    mode: {
      type: 'enum',
      default: 'tree',
      options: [
        { value: 'tree', label: 'Tree' },
        { value: 'flat', label: 'Flat' },
      ],
      label: 'Mode',
    },
  },
  quiet: undefined,
} as const satisfies PluginSchemas;

/** A file carrying both halves. */
function withPlugins(plugins: unknown, settings: unknown = DEFAULT_SETTINGS): string {
  return JSON.stringify({
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    exportedAt: '2026-07-25T00:00:00.000Z',
    settings,
    plugins,
  });
}

test('a plugin bag round trips through its own schema', () => {
  const bags = { outline: { enabled: false, depth: 5, mode: 'flat' } };
  const text = serializeSettings(DEFAULT_SETTINGS, new Date(), bags);
  const result = ok(parseSettingsFile(text, SCHEMAS));

  assert.deepEqual(result.plugins.outline, { enabled: false, depth: 5, mode: 'flat' });
  assert.deepEqual(result.notes, []);
});

test('a file with no plugins section says nothing about plugins', () => {
  // Absent is not "reset": a plugin the file never mentions has to keep the
  // settings the reader already has, exactly as a missing global setting does.
  const result = ok(parseSettingsFile(serializeSettings(DEFAULT_SETTINGS), SCHEMAS));
  assert.deepEqual(Object.keys(result.plugins), []);
  assert.ok(!Object.hasOwn(buildSettingsFile(DEFAULT_SETTINGS), 'plugins'));
});

test('a plugin this build does not have is reported by name and dropped', () => {
  const result = ok(
    parseSettingsFile(withPlugins({ telemetry: { enabled: true }, outline: {} }), SCHEMAS),
  );

  assert.ok(!Object.hasOwn(result.plugins, 'telemetry'));
  assert.ok(Object.hasOwn(result.plugins, 'outline'));
  assert.ok(result.notes.some((note) => note.includes('telemetry')));
});

test("a key the plugin does not declare cannot reach its bag", () => {
  const result = ok(
    parseSettingsFile(withPlugins({ outline: { depth: 2, endpoint: 'https://x.example' } }), SCHEMAS),
  );

  assert.deepEqual(result.plugins.outline, { depth: 2 });
  // Named as `id.key`, so "which plugin" is answerable from the note alone.
  assert.ok(result.notes.some((note) => note.includes('outline.endpoint')));
});

test('a plugin with no settings can still have its enabled flag imported', () => {
  const result = ok(parseSettingsFile(withPlugins({ quiet: { enabled: false } }), SCHEMAS));
  assert.deepEqual(result.plugins.quiet, { enabled: false });
});

test('plugin numbers are clamped and plugin strings are capped', () => {
  const result = ok(
    parseSettingsFile(withPlugins({ outline: { depth: 99, label: 'x'.repeat(40) } }), SCHEMAS),
  );

  assert.equal(result.plugins.outline.depth, 6);
  assert.equal((result.plugins.outline.label as string).length, 8);
  assert.ok(result.notes.some((note) => /allowed range/.test(note)));
});

test('a plugin value of the wrong kind is dropped, not defaulted in silence', () => {
  const result = ok(
    parseSettingsFile(
      withPlugins({ outline: { depth: 'three', mode: 'spiral', enabled: 'yes' } }),
      SCHEMAS,
    ),
  );

  // Dropped rather than written as the default: the file did not ask for the
  // default, and a bag with no key leaves whatever is stored alone.
  assert.deepEqual(result.plugins.outline, {});
  assert.ok(result.notes.some((note) => /wrong kind/.test(note)));
  assert.ok(result.notes.some((note) => note.includes('outline.enabled')));
});

test('with no schemas at all, every plugin in the file is reported unrecognised', () => {
  const result = ok(parseSettingsFile(withPlugins({ outline: { depth: 2 } })));
  assert.deepEqual(Object.keys(result.plugins), []);
  assert.ok(result.notes.some((note) => note.includes('outline')));
});

test('a __proto__ plugin id pollutes nothing', () => {
  // The plugin id comes out of the file, so `plugins.__proto__` is a key an
  // attacker controls. It is not a plugin this build knows, so it is dropped —
  // and the bag it would have landed in has a null prototype regardless.
  const text =
    `{"format":"${SETTINGS_FILE_FORMAT}","version":1,"settings":{},` +
    `"plugins":{"__proto__":{"polluted":"yes"},"outline":{"depth":2}}}`;

  const result = ok(parseSettingsFile(text, SCHEMAS));

  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(result.plugins), null);
  assert.deepEqual(result.plugins.outline, { depth: 2 });
});

test('a plugins section that is not an object is ignored, not fatal', () => {
  for (const plugins of [null, 'outline', 42, ['outline']]) {
    const result = ok(parseSettingsFile(withPlugins(plugins), SCHEMAS));
    assert.deepEqual(Object.keys(result.plugins), []);
  }
});

test('importing merges plugin bags rather than replacing them', () => {
  // The stored shape, as the host writes it.
  data.pluginSettings = {
    version: 1,
    global: {},
    plugins: { outline: { depth: 4 }, quiet: { enabled: true } },
  };

  return importSettings(withPlugins({ outline: { mode: 'flat' } }), SCHEMAS).then((result) => {
    assert.ok(result.ok);
    const stored = data.pluginSettings as { plugins: Record<string, unknown> };
    // `depth` was not in the file, so it survives; `mode` is added.
    assert.deepEqual(stored.plugins.outline, { depth: 4, mode: 'flat' });
    assert.deepEqual(stored.plugins.quiet, { enabled: true });
  });
});
