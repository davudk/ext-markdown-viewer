/**
 * Theme presets, the user stylesheet, and per-document pins.
 *
 * Two of the three claims this file makes are not opinions and are asserted as
 * arithmetic rather than reviewed by eye:
 *
 *   Contrast. Every palette is recomputed against every foreground/background
 *   pair the viewer actually paints, on every run. A preset added later that
 *   looks lovely and puts 3.1:1 grey comments on a grey code block fails here
 *   rather than in someone's eyes six months on.
 *
 *   Escape. The user stylesheet is wrapped in a selector, and a wrapper is only
 *   a boundary if nothing can close it early. The hostile inputs below are the
 *   ones that would reach past it: a stray `}`, an `@import` hidden in a
 *   comment, a `url()` hidden in a string.
 *
 * chrome.storage is faked with a plain object, as in `document-state.test.ts`:
 * what matters is which keys end up in it and which survive eviction.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { JSDOM } from 'jsdom';

import {
  DEFAULT_SETTINGS,
  DOCUMENT_THEME_KEY,
  DOCUMENT_THEME_LIMIT,
  CUSTOM_CSS_MAX_LENGTH,
  THEME_TOKENS,
} from '../lib/config.ts';
import {
  THEME_PRESETS,
  applyDocumentTheme,
  checkContrast,
  clearAllDocumentThemes,
  clearDocumentTheme,
  contrastRatio,
  CONTRAST_AA,
  CONTRAST_AAA,
  CUSTOM_CSS_STYLE_ID,
  getPreset,
  isPresetId,
  listDocumentThemes,
  loadDocumentTheme,
  parseHex,
  paletteFor,
  PRESET_OPTIONS,
  PRESET_STYLE_ID,
  presetStyleText,
  pruneThemesToLimit,
  resolvePolarity,
  resolveTheme,
  sanitizeCustomCss,
  setDocumentTheme,
} from '../lib/theme-presets.ts';

/* -------------------------------------------------------------------------- */
/* Fake storage                                                                */
/* -------------------------------------------------------------------------- */

type Data = Record<string, unknown>;

function fakeStorage(): Data {
  const data: Data = {};
  setChrome({
    storage: {
      local: {
        async get(key: string) {
          return key in data ? { [key]: data[key] } : {};
        },
        async set(items: Data) {
          Object.assign(data, items);
        },
        async remove(key: string) {
          delete data[key];
        },
      },
    },
  });
  return data;
}

function brokenStorage(): void {
  const fail = async () => {
    throw new Error('storage unavailable');
  };
  setChrome({ storage: { local: { get: fail, set: fail, remove: fail } } });
}

function setChrome(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = value;
}

let data: Data;

beforeEach(() => {
  data = fakeStorage();
});

/* -------------------------------------------------------------------------- */
/* Colour arithmetic                                                           */
/* -------------------------------------------------------------------------- */

test('contrast is computed the way WCAG defines it', () => {
  // The two anchors the formula has to hit exactly, or every figure derived
  // from it is off by an unknown amount.
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(contrastRatio('#4a5568', '#4a5568'), 1);
  // Symmetric: which colour is named first must not change the answer.
  assert.equal(
    contrastRatio('#0a53be', '#ffffff'),
    contrastRatio('#ffffff', '#0a53be'),
  );
  // A known reference point: mid grey on white.
  assert.equal(Math.round(contrastRatio('#767676', '#ffffff') * 100) / 100, 4.54);
});

test('only opaque six-digit hex is a colour', () => {
  // Anything else would make the ratios below depend on what was painted
  // underneath, and no static check could then say a preset is readable.
  assert.deepEqual(parseHex('#0a53be'), [10, 83, 190]);
  assert.deepEqual(parseHex('  #FFFFFF '), [255, 255, 255]);
  assert.equal(parseHex('#fff'), null);
  assert.equal(parseHex('rgb(0,0,0)'), null);
  assert.equal(parseHex('#0a53be80'), null);
});

/* -------------------------------------------------------------------------- */
/* Preset shape                                                                */
/* -------------------------------------------------------------------------- */

test('every palette covers exactly the token set', () => {
  // A preset missing a token is the failure that reads as a bug: the document
  // takes the new palette and the code blocks keep the old one.
  const expected = [...THEME_TOKENS].sort();

  for (const preset of THEME_PRESETS) {
    for (const polarity of ['light', 'dark'] as const) {
      assert.deepEqual(
        Object.keys(preset[polarity]).sort(),
        expected,
        `${preset.id}/${polarity} does not cover the token set`,
      );
    }
  }
});

test('every colour is an opaque hex', () => {
  for (const preset of THEME_PRESETS) {
    for (const polarity of ['light', 'dark'] as const) {
      for (const token of THEME_TOKENS) {
        const value = preset[polarity][token];
        assert.ok(
          parseHex(value),
          `${preset.id}/${polarity} --mdv-${token} is not #rrggbb: ${value}`,
        );
      }
    }
  }
});

test('preset ids are unique and the default is one of them', () => {
  const ids = THEME_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(DEFAULT_SETTINGS.themePreset));
  assert.equal(PRESET_OPTIONS.length, THEME_PRESETS.length);

  for (const preset of THEME_PRESETS) {
    assert.ok(preset.label.length > 0, `${preset.id} has no label`);
    assert.ok(preset.note.length > 0, `${preset.id} has no description`);
  }
});

test('a light half is lighter than its dark half', () => {
  // Cheap, but it is the check that catches the two halves being pasted in the
  // wrong order — which nothing else here would notice, since both would pass
  // contrast perfectly well.
  for (const preset of THEME_PRESETS) {
    assert.ok(
      contrastRatio(preset.light.bg, '#000000') >
        contrastRatio(preset.dark.bg, '#000000'),
      `${preset.id}: the light half is not lighter than the dark one`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Contrast                                                                    */
/* -------------------------------------------------------------------------- */

test('every preset clears WCAG AA on every pair the viewer paints', () => {
  for (const preset of THEME_PRESETS) {
    for (const polarity of ['light', 'dark'] as const) {
      const findings = checkContrast(preset[polarity], CONTRAST_AA);
      assert.deepEqual(
        findings.map((f) => `${f.fg} on ${f.bg} (${f.what}) — ${f.ratio.toFixed(2)}:1`),
        [],
        `${preset.id}/${polarity} falls below ${CONTRAST_AA}:1`,
      );
    }
  }
});

test('the high-contrast preset clears AAA', () => {
  const preset = getPreset('high-contrast');
  assert.equal(preset.id, 'high-contrast', 'the AAA preset must exist');

  for (const polarity of ['light', 'dark'] as const) {
    const findings = checkContrast(preset[polarity], CONTRAST_AAA);
    assert.deepEqual(
      findings.map((f) => `${f.fg} on ${f.bg} (${f.what}) — ${f.ratio.toFixed(2)}:1`),
      [],
      `high-contrast/${polarity} falls below ${CONTRAST_AAA}:1`,
    );
  }
});

test('the contrast check actually fails a palette that deserves it', () => {
  // Guards the guard. A `checkContrast` that returned [] unconditionally would
  // make every assertion above vacuous and nothing else would notice.
  const broken = { ...getPreset('default').light, 'fg-muted': '#c8c8c8' };
  const findings = checkContrast(broken, CONTRAST_AA);

  assert.ok(findings.length > 0);
  assert.ok(findings.every((finding) => finding.ratio < CONTRAST_AA));
  assert.ok(findings.some((finding) => finding.fg === 'fg-muted'));
});

/* -------------------------------------------------------------------------- */
/* Composition with light/dark/auto                                            */
/* -------------------------------------------------------------------------- */

test('a preset picks the family, the theme setting still picks the half', () => {
  // The whole composition rule in one assertion: changing the preset must never
  // change the polarity, and changing the theme must never change the family.
  for (const preset of THEME_PRESETS) {
    const settings = { theme: 'dark' as const, themePreset: preset.id };
    const resolved = resolveTheme({ settings, prefersDark: false });

    assert.equal(resolved.polarity, 'dark');
    assert.equal(resolved.preset.id, preset.id);
    assert.deepEqual(resolved.palette, preset.dark);
  }
});

test('auto defers to the system, whichever preset is chosen', () => {
  assert.equal(resolvePolarity('auto', true), 'dark');
  assert.equal(resolvePolarity('auto', false), 'light');
  // An explicit choice overrides the system in both directions.
  assert.equal(resolvePolarity('light', true), 'light');
  assert.equal(resolvePolarity('dark', false), 'dark');

  const settings = { theme: 'auto' as const, themePreset: 'nord' as const };
  assert.deepEqual(
    resolveTheme({ settings, prefersDark: true }).palette,
    getPreset('nord').dark,
  );
  assert.deepEqual(
    resolveTheme({ settings, prefersDark: false }).palette,
    getPreset('nord').light,
  );
});

test('an unknown preset id falls back rather than throwing', () => {
  // Storage outlives the code that wrote it: a preset removed in a later build
  // must degrade to the default, not leave the viewer unstyled.
  assert.equal(getPreset('a-preset-that-was-removed').id, DEFAULT_SETTINGS.themePreset);
  assert.equal(getPreset(undefined).id, DEFAULT_SETTINGS.themePreset);
  assert.ok(isPresetId('nord'));
  assert.ok(!isPresetId('nord '));
  assert.ok(!isPresetId(7));
});

/* -------------------------------------------------------------------------- */
/* Per-document pins                                                           */
/* -------------------------------------------------------------------------- */

test('a pin overrides the global setting for that document only', () => {
  const settings = { theme: 'light' as const, themePreset: 'default' as const };

  const pinned = resolveTheme({
    settings,
    override: { theme: 'dark', preset: 'gruvbox' },
  });
  assert.equal(pinned.polarity, 'dark');
  assert.equal(pinned.preset.id, 'gruvbox');
  assert.ok(pinned.pinned);

  // And with nothing pinned, the globals come straight through.
  const plain = resolveTheme({ settings, override: null });
  assert.equal(plain.polarity, 'light');
  assert.equal(plain.preset.id, 'default');
  assert.ok(!plain.pinned);
});

test('either half of a pin can be set alone', () => {
  const settings = { theme: 'dark' as const, themePreset: 'nord' as const };

  // Preset only: this document reads better in Solarized, but keep my polarity.
  const preset = resolveTheme({ settings, override: { theme: null, preset: 'solarized' } });
  assert.equal(preset.polarity, 'dark');
  assert.equal(preset.preset.id, 'solarized');

  // Polarity only: this document has to stay light, in whatever family.
  const polarity = resolveTheme({ settings, override: { theme: 'light', preset: null } });
  assert.equal(polarity.polarity, 'light');
  assert.equal(polarity.preset.id, 'nord');
});

test('a pin round-trips for any spelling of the same url', async () => {
  await setDocumentTheme('https://example.com/a.md', { theme: 'dark', preset: 'nord' });

  assert.deepEqual(await loadDocumentTheme('https://example.com/a.md#setup'), {
    theme: 'dark',
    preset: 'nord',
  });
});

test('pins live under their own key, apart from settings and scroll memory', async () => {
  data.settings = { theme: 'dark' };
  data.documents = { 'https://example.com/a.md': {} };

  await setDocumentTheme('https://example.com/a.md', { theme: null, preset: 'nord' });
  await clearAllDocumentThemes();

  assert.deepEqual(data.settings, { theme: 'dark' });
  assert.ok(data.documents, 'clearing pins must not touch scroll memory');
  assert.ok(!(DOCUMENT_THEME_KEY in data));
});

test('pinning nothing clears the entry instead of storing an empty one', async () => {
  // An override that pins neither half is indistinguishable from no override,
  // and would otherwise sit in the list forever with nothing to show.
  await setDocumentTheme('https://example.com/a.md', { theme: 'dark', preset: null });
  await setDocumentTheme('https://example.com/a.md', { theme: null, preset: null });

  assert.equal(await loadDocumentTheme('https://example.com/a.md'), null);
  assert.deepEqual(await listDocumentThemes(), []);
});

test('a single pin can be cleared without touching the rest', async () => {
  await setDocumentTheme('https://example.com/a.md', { theme: 'dark', preset: null });
  await setDocumentTheme('https://example.com/b.md', { theme: 'light', preset: null });
  await clearDocumentTheme('https://example.com/a.md');

  assert.equal(await loadDocumentTheme('https://example.com/a.md'), null);
  assert.ok(await loadDocumentTheme('https://example.com/b.md'));
});

test('the pin list is ordered most recently used first', async () => {
  await setDocumentTheme('https://example.com/a.md', { theme: 'dark', preset: null });
  await setDocumentTheme('https://example.com/b.md', { theme: 'light', preset: null });
  await loadDocumentTheme('https://example.com/a.md');

  const listed = await listDocumentThemes();
  assert.deepEqual(
    listed.map((entry) => entry.key),
    ['https://example.com/a.md', 'https://example.com/b.md'],
  );
});

test('pins stop growing at the limit, least recently used first', async () => {
  for (let i = 0; i < DOCUMENT_THEME_LIMIT + 5; i += 1) {
    await setDocumentTheme(`https://example.com/${i}.md`, {
      theme: 'dark',
      preset: null,
    });
  }

  assert.equal((await listDocumentThemes()).length, DOCUMENT_THEME_LIMIT);
  assert.equal(await loadDocumentTheme('https://example.com/0.md'), null);
  assert.ok(await loadDocumentTheme('https://example.com/5.md'));
});

test('reading a pin refreshes its recency', async () => {
  for (let i = 0; i < DOCUMENT_THEME_LIMIT; i += 1) {
    await setDocumentTheme(`https://example.com/${i}.md`, {
      theme: 'dark',
      preset: null,
    });
  }

  await loadDocumentTheme('https://example.com/0.md');
  await setDocumentTheme('https://example.com/new.md', { theme: 'light', preset: null });

  assert.ok(
    await loadDocumentTheme('https://example.com/0.md'),
    'the recently opened document should have kept its pin',
  );
  assert.equal(await loadDocumentTheme('https://example.com/1.md'), null);
});

test('writes inside one millisecond still evict in order', () => {
  const themes: Record<string, { override: { theme: null; preset: null }; usedAt: number }> =
    {};
  for (let i = 0; i < 5; i += 1) {
    themes[`k${i}`] = { override: { theme: null, preset: null }, usedAt: 1 };
  }
  themes.k4.usedAt = 2;

  const kept = Object.keys(pruneThemesToLimit(themes, 2));
  assert.equal(kept.length, 2);
  assert.ok(kept.includes('k4'));
});

test('corrupt pins are dropped, not propagated', async () => {
  data[DOCUMENT_THEME_KEY] = {
    'https://example.com/good.md': {
      override: { theme: 'dark', preset: 'nord' },
      usedAt: 5,
    },
    'https://example.com/stale.md': {
      // A preset that no longer exists, and a theme that never did.
      override: { theme: 'sepia', preset: 'dracula' },
      usedAt: 5,
    },
    'https://example.com/bad.md': { override: 'nonsense', usedAt: 5 },
    'https://example.com/worse.md': 7,
  };

  assert.deepEqual(await loadDocumentTheme('https://example.com/good.md'), {
    theme: 'dark',
    preset: 'nord',
  });
  // Both halves were unusable, so the entry pinned nothing and went with them.
  assert.equal(await loadDocumentTheme('https://example.com/stale.md'), null);
  assert.equal(await loadDocumentTheme('https://example.com/bad.md'), null);
  assert.equal((await listDocumentThemes()).length, 1);
});

test('a storage failure degrades instead of throwing', async () => {
  brokenStorage();

  await assert.doesNotReject(() =>
    setDocumentTheme('https://example.com/a.md', { theme: 'dark', preset: null }),
  );
  assert.equal(await loadDocumentTheme('https://example.com/a.md'), null);
  assert.deepEqual(await listDocumentThemes(), []);
  await assert.doesNotReject(clearAllDocumentThemes);
});

/* -------------------------------------------------------------------------- */
/* Emitting a preset                                                           */
/* -------------------------------------------------------------------------- */

test('a preset emits both halves, on screen only', () => {
  const css = presetStyleText(getPreset('gruvbox'));

  assert.match(css, /^@media screen \{/);
  // Printing re-declares the whole token set to force an ink-friendly palette.
  // Emitted outside a media query, a preset would come later in the cascade and
  // start printing brown paper.
  assert.ok(!css.includes('@media print'));
  assert.match(css, /:root:root\[data-mdv-theme='light'\]/);
  assert.match(css, /:root:root\[data-mdv-theme='dark'\]/);

  for (const token of THEME_TOKENS) {
    assert.ok(css.includes(`--mdv-${token}:`), `--mdv-${token} is not emitted`);
  }
});

test('a preset stylesheet references nothing', () => {
  // The zero-network guarantee, restated where a palette could break it: an
  // emitted sheet has to be colours and nothing else.
  for (const preset of THEME_PRESETS) {
    const css = presetStyleText(preset);
    assert.ok(!/url\(/i.test(css), `${preset.id} emits a url()`);
    assert.ok(!/@import/i.test(css), `${preset.id} emits an @import`);
  }
});

test('the palette a preset emits is the one it resolves to', () => {
  const palette = paletteFor('solarized', 'light');
  const css = presetStyleText(getPreset('solarized'));
  assert.ok(css.includes(`--mdv-bg: ${palette.bg};`));
});

/* -------------------------------------------------------------------------- */
/* User CSS — what is removed                                                  */
/* -------------------------------------------------------------------------- */

/** The sanitized rules, unscoped, with whitespace flattened for comparison. */
function rules(input: string): string {
  return sanitizeCustomCss(input).rules.replace(/\s+/g, ' ').trim();
}

test('empty input applies nothing at all', () => {
  const result = sanitizeCustomCss('   \n  ');
  assert.equal(result.css, '');
  assert.deepEqual(result.removals, []);
  assert.equal(result.error, null);
});

test('ordinary css survives untouched', () => {
  assert.equal(
    rules('h1 { color: rebeccapurple; } p { line-height: 1.9; }'),
    'h1 { color: rebeccapurple; } p { line-height: 1.9; }',
  );
});

test('@import is removed and reported', () => {
  // An @import is a network request wearing a stylesheet, and this extension
  // makes none.
  const result = sanitizeCustomCss("@import url('https://fonts.example/f.css');\nh1 { color: red; }");

  assert.ok(!result.css.includes('@import'));
  assert.ok(result.css.includes('color: red'));
  assert.deepEqual(
    result.removals.map((removal) => removal.kind),
    ['import'],
  );
});

test('@import in all its spellings is removed', () => {
  for (const input of [
    '@import "theme.css";',
    "@IMPORT url(theme.css);",
    '@import url("x.css") screen;',
    '@charset "utf-8";',
  ]) {
    const result = sanitizeCustomCss(`${input} p { color: red; }`);
    assert.ok(!/@import|@charset/i.test(result.css), `not removed: ${input}`);
    assert.ok(result.css.includes('color: red'), `over-removed: ${input}`);
  }
});

test('a remote url() is removed, leaving an inert declaration', () => {
  const result = sanitizeCustomCss(
    'body { background-image: url(https://tracker.example/pixel.png); color: red; }',
  );

  assert.ok(!result.css.includes('tracker.example'));
  // The declaration is left invalid on purpose: the CSS parser discards it, so
  // nothing has to be reconstructed and the rest of the rule still applies.
  assert.ok(result.css.includes('background-image: ;'));
  assert.ok(result.css.includes('color: red'));
  assert.equal(result.removals[0].kind, 'remote-url');
});

test('every non-data url() target is removed, however it is spelled', () => {
  for (const target of [
    'https://a.example/x.png',
    'http://a.example/x.png',
    '//a.example/x.png',
    'file:///etc/passwd',
    '"https://a.example/x.png"',
    "'  https://a.example/x.png  '",
    '/local/relative.png',
    'relative.png',
  ]) {
    const result = sanitizeCustomCss(`p { background: url(${target}); }`);
    assert.ok(
      !result.css.includes('url('),
      `url(${target}) survived`,
    );
    assert.equal(result.removals.length, 1, `url(${target}) was not reported`);
  }
});

test('a data: url survives, because it is bytes the user already has', () => {
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const result = sanitizeCustomCss(`p { background-image: url("${png}"); }`);

  assert.ok(result.css.includes(png));
  assert.deepEqual(result.removals, []);
});

test('a url() inside a string is left alone, and one inside a comment is not acted on', () => {
  // The scan is a tokenizer rather than a regex for exactly this: a naive
  // pattern both mangles harmless content and misses nothing real.
  const quoted = sanitizeCustomCss(`p::after { content: "url(https://a.example/x)"; }`);
  assert.deepEqual(quoted.removals, []);
  assert.ok(quoted.css.includes('https://a.example/x'));

  const commented = sanitizeCustomCss('/* @import "evil.css"; */ p { color: red; }');
  assert.deepEqual(commented.removals, []);
  assert.ok(commented.css.includes('color: red'));
});

test('an @import that a naive scan would miss is still removed', () => {
  // The comment ends before the at-rule starts; anything that skipped to the
  // next `*/` and resumed would swallow the real @import with it.
  const result = sanitizeCustomCss('/* nothing here */@import "evil.css"; p { color: red; }');
  assert.equal(result.removals.length, 1);
  assert.ok(!result.css.includes('evil.css'));
});

test('an identifier ending in url is not a url()', () => {
  const result = sanitizeCustomCss('p { --my-url: 1; background: myurl(x); }');
  assert.deepEqual(result.removals, []);
  assert.ok(result.css.includes('myurl(x)'));
});

test('`</` is removed, so the sheet stays safe to serialize', () => {
  const result = sanitizeCustomCss('p { color: red; } </style><script>alert(1)</script>');
  assert.ok(!result.css.includes('</'));
  assert.ok(result.removals.some((removal) => removal.kind === 'markup'));
});

test('control characters are dropped', () => {
  // The classic way to smuggle a keyword past a scan that compares text.
  const result = sanitizeCustomCss('@im\u0000port "evil.css"; p { color: red; }');
  assert.ok(!result.css.includes('evil.css'));
  assert.equal(result.removals[0].kind, 'import');
});

test('input over the cap is cut at it and reported', () => {
  const long = `p { color: red; }\n`.repeat(4000);
  assert.ok(long.length > CUSTOM_CSS_MAX_LENGTH);

  const result = sanitizeCustomCss(long);
  assert.ok(result.truncated);
  assert.ok(result.rules.length <= CUSTOM_CSS_MAX_LENGTH + 8);
});

/* -------------------------------------------------------------------------- */
/* User CSS — the scope boundary                                               */
/* -------------------------------------------------------------------------- */

test('rules are wrapped so they can only reach a rendered document', () => {
  const result = sanitizeCustomCss('color: red;');

  assert.match(result.css, /^@media screen \{\n#mdv-root \.mdv-body \{/);
  // `.mdv-body` is the document column. The table of contents is a <nav> and
  // the toolbar a <button>, both outside it, so user CSS cannot hide the
  // viewer's own controls.
  assert.ok(result.css.trimEnd().endsWith('}'));
});

test('a stray closing brace rejects the whole stylesheet', () => {
  // The one construct that could close the wrapper above and start writing
  // rules against the rest of the page. Partially honouring it is not an option.
  const result = sanitizeCustomCss('p { color: red; } } #mdv-root nav { display: none; }');

  assert.ok(result.error);
  assert.equal(result.css, '');
  assert.equal(result.rules, '');
});

test('a brace hidden in a string or comment does not count', () => {
  // The counter has to agree with the CSS parser about what a brace is, in both
  // directions: miscounting one way rejects valid input, the other way lets an
  // escape through.
  assert.equal(sanitizeCustomCss('p::after { content: "}"; }').error, null);
  assert.equal(sanitizeCustomCss('p { color: red; } /* } */').error, null);
  assert.equal(sanitizeCustomCss("p::after { content: '}}}'; }").error, null);
});

test('a block left open mid-edit is closed rather than rejected', () => {
  // Live-applied CSS spends most of its life half-typed. The parser would close
  // it at the end of the file anyway; doing it here keeps the wrapper balanced.
  const result = sanitizeCustomCss('h1 { color: red;');
  assert.equal(result.error, null);
  assert.ok(result.rules.trimEnd().endsWith('}'));
  assert.ok(result.css.includes('color: red'));
});

test('an escape attempt is refused even when it is the only content', () => {
  const result = sanitizeCustomCss('} html { display: none; }');
  assert.ok(result.error);
  assert.equal(result.css, '');
});

/* -------------------------------------------------------------------------- */
/* Applying to a document                                                      */
/* -------------------------------------------------------------------------- */

function newDocument(): Document {
  return new JSDOM('<!doctype html><html><head></head><body></body></html>').window
    .document;
}

test('applying writes the polarity and both style elements', () => {
  const doc = newDocument();

  const { resolved } = applyDocumentTheme(doc, {
    settings: {
      theme: 'auto',
      themePreset: 'nord',
      customCss: 'h1 { letter-spacing: 0; }',
    },
    prefersDark: true,
  });

  assert.equal(resolved.polarity, 'dark');
  assert.equal(doc.documentElement.dataset.mdvTheme, 'dark');
  assert.ok(doc.getElementById(PRESET_STYLE_ID)?.textContent?.includes('--mdv-bg:'));
  assert.ok(
    doc.getElementById(CUSTOM_CSS_STYLE_ID)?.textContent?.includes('letter-spacing'),
  );
});

test('applying again replaces rather than stacks', () => {
  const doc = newDocument();
  const settings = { theme: 'light' as const, themePreset: 'nord' as const, customCss: '' };

  applyDocumentTheme(doc, { settings });
  applyDocumentTheme(doc, { settings: { ...settings, themePreset: 'gruvbox' } });

  assert.equal(doc.querySelectorAll('style').length, 1);
  assert.ok(
    doc
      .getElementById(PRESET_STYLE_ID)
      ?.textContent?.includes(getPreset('gruvbox').light.bg),
  );
});

test('clearing the custom css removes its style element entirely', () => {
  const doc = newDocument();
  const settings = { theme: 'light' as const, themePreset: 'default' as const };

  applyDocumentTheme(doc, { settings: { ...settings, customCss: 'p { color: red; }' } });
  assert.ok(doc.getElementById(CUSTOM_CSS_STYLE_ID));

  applyDocumentTheme(doc, { settings: { ...settings, customCss: '' } });
  assert.equal(doc.getElementById(CUSTOM_CSS_STYLE_ID), null);
});

test('css that could not be made safe is not applied at all', () => {
  const doc = newDocument();

  const { css } = applyDocumentTheme(doc, {
    settings: {
      theme: 'light',
      themePreset: 'default',
      customCss: '} nav { display: none; }',
    },
  });

  assert.ok(css.error);
  assert.equal(doc.getElementById(CUSTOM_CSS_STYLE_ID), null);
});
