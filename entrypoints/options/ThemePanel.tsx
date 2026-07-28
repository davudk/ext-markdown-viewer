/**
 * The theme plugin's own settings: polarity, preset, and the reader's CSS.
 *
 * These used to be the top of a page-wide "General" card, three cards away from
 * the plugin whose behaviour they describe. They are the same rows, in the same
 * markup, rendered inside `plugins/theme`'s section — see `owned.ts` for why
 * the values themselves did not move with them.
 *
 * None of the three is expressible as a `SettingDefinition`: the preset picker
 * paints live swatches from the half of the palette in use, the preview is the
 * palette's own custom properties rendering, and the editor reports what
 * sanitising removed on every keystroke. So this is hand-written, out of the
 * same `row`/`row-title`/`row-desc` pieces the generated rows use.
 */

import { useMemo, type CSSProperties } from 'react';

import { CUSTOM_CSS_MAX_LENGTH, THEME_TOKENS } from '@/lib/config';
import {
  getPreset,
  PRESET_OPTIONS,
  sanitizeCustomCss,
  type ThemePalette,
  type ThemePresetId,
} from '@/lib/theme-presets';
import { THEME_OPTIONS, type Theme } from '@/lib/settings';

import { Message, Segmented, type Notice } from './controls';

/**
 * Every token of a palette as inline custom properties, so the preview below is
 * drawn by the same variables a real document is — not by a hand-built
 * approximation that could agree with the palette one week and not the next.
 */
function paletteVars(palette: ThemePalette): CSSProperties {
  const vars: Record<string, string> = {};
  for (const token of THEME_TOKENS) vars[`--mdv-${token}`] = palette[token];
  return vars as CSSProperties;
}

export function ThemePanel({
  theme,
  preset,
  customCss,
  polarity,
  notice,
  onTheme,
  onPreset,
  onCustomCss,
  onClearCss,
}: {
  theme: Theme;
  preset: ThemePresetId;
  customCss: string;
  /** The half of the preset the reader would actually be shown right now. */
  polarity: 'light' | 'dark';
  notice: Notice | null;
  onTheme: (next: Theme) => void;
  onPreset: (next: ThemePresetId) => void;
  onCustomCss: (next: string) => void;
  onClearCss: () => void;
}) {
  const palette = getPreset(preset)[polarity];

  /**
   * What would happen to the stylesheet if it were applied as typed. Recomputed
   * on every keystroke rather than on save, because the whole point is to say
   * what was dropped while there is still something to do about it.
   */
  const cssReport = useMemo(() => sanitizeCustomCss(customCss), [customCss]);
  const removedUrls = cssReport.removals.filter(
    (removal) => removal.kind === 'remote-url',
  ).length;
  const removedImports = cssReport.removals.filter(
    (removal) => removal.kind === 'import',
  ).length;
  const removedMarkup = cssReport.removals.filter(
    (removal) => removal.kind === 'markup',
  ).length;

  return (
    <>
      <div className="row">
        <div className="row-text">
          <h3 className="row-title" id="theme-label">
            Theme
          </h3>
          <p className="row-desc">
            Applies to rendered documents, the popup and this page.{' '}
            <strong>Auto</strong> follows your system setting; light and dark
            override it in both directions.
          </p>
        </div>

        <Segmented
          name="theme"
          value={theme}
          options={THEME_OPTIONS}
          labelledBy="theme-label"
          onChange={onTheme}
        />
      </div>

      <div className="row row-stack">
        <div className="row-text">
          <h3 className="row-title" id="preset-label">
            Colour preset
          </h3>
          <div className="row-desc" id="preset-desc">
            <p>
              Which palette rendered documents are drawn from. This is a
              separate choice from <strong>Theme</strong> above and does not
              override it: every preset comes in a light and a dark half, and
              the setting above still decides which half you get — including{' '}
              <strong>Auto</strong>, which keeps following your system.
            </p>
            <p>
              Every preset meets the WCAG AA contrast minimum for body text,
              muted text, links and syntax highlighting, measured against the
              surface each one is actually painted on.{' '}
              <strong>High contrast</strong> meets the stricter AAA level
              throughout.
            </p>
          </div>
        </div>

        <div
          className="presets"
          role="radiogroup"
          aria-labelledby="preset-label"
          aria-describedby="preset-desc"
        >
          {PRESET_OPTIONS.map(({ value, label, note, swatch }) => (
            <label
              key={value}
              className={value === preset ? 'preset is-on' : 'preset'}
            >
              <input
                type="radio"
                name="theme-preset"
                value={value}
                checked={value === preset}
                onChange={() => onPreset(value)}
              />
              <span className="preset-body">
                {/* The half that is actually in use, so the chips are the
                    colours this reader would get rather than an average of two
                    palettes they will only ever see one of. */}
                <span className="preset-swatch" aria-hidden="true">
                  {swatch[polarity].map((colour, index) => (
                    <span key={index} style={{ background: colour }} />
                  ))}
                </span>
                <span className="preset-text">
                  <span className="preset-name">{label}</span>
                  <span className="preset-note">{note}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="row row-stack">
        <h3 className="row-title" id="palette-label">
          Preview
        </h3>
        {/* Drawn from the preset's own custom properties, the same ones the
            viewer's stylesheet reads — so this is the palette itself, not a
            drawing of it that could drift. */}
        <div
          className="palette"
          style={paletteVars(palette)}
          role="group"
          aria-labelledby="palette-label"
        >
          <p className="palette-title">Notes on the estuary</p>
          <p className="palette-body">
            The tide runs out twice a day and leaves the whole channel bare.{' '}
            <a href="#preset-label">A link</a>, some{' '}
            <code className="palette-code">inline code</code>, and a line of{' '}
            <span className="palette-muted">quieter text beneath it</span>.
          </p>
          <pre className="palette-pre">
            <span className="tk-comment">
              // syntax colours are part of the preset
            </span>
            {'\n'}
            <span className="tk-keyword">export function</span>{' '}
            <span className="tk-title">tide</span>(
            <span className="tk-punct">hours</span>) {'{'}
            {'\n  '}
            <span className="tk-keyword">return</span>{' '}
            <span className="tk-string">'ebb'</span>,{' '}
            <span className="tk-number">2</span>;{'\n'}
            {'}'}
          </pre>
        </div>
      </div>

      <div className="row row-stack">
        <label className="row-title" htmlFor="custom-css">
          CSS applied to rendered documents
        </label>
        <div className="row-desc" id="custom-css-desc">
          <p>
            Applied on top of the theme, to the document itself and nothing
            else. Selectors are relative to the document body, so <code>h1</code>{' '}
            means a heading in the file — the viewer's own sidebar and toolbar,
            the popup and this page are all out of reach, by construction rather
            than by convention.
          </p>
          <p>
            Two things are removed before it is applied, and you are told when
            they are: <code>@import</code>, and any <code>url()</code> that is
            not a <code>data:</code> one. Both would make the viewer request
            something over the network, and it never requests anything.
          </p>
        </div>

        <textarea
          id="custom-css"
          className="editor"
          value={customCss}
          spellCheck={false}
          rows={8}
          maxLength={CUSTOM_CSS_MAX_LENGTH}
          aria-describedby="custom-css-desc custom-css-report"
          placeholder={'blockquote {\n  font-style: italic;\n}'}
          onChange={(event) => onCustomCss(event.target.value)}
        />

        <p className="editor-count">
          {customCss.length.toLocaleString()} of{' '}
          {CUSTOM_CSS_MAX_LENGTH.toLocaleString()} characters
        </p>

        {/* Always in the DOM so a change is announced, and phrased as what
            happened rather than as a warning — the reader wrote this. */}
        <p
          id="custom-css-report"
          className={
            cssReport.error
              ? 'msg is-error'
              : cssReport.removals.length > 0 || cssReport.truncated
                ? 'msg is-info'
                : 'msg'
          }
          role="status"
          aria-live="polite"
        >
          {cssReport.error ??
            [
              removedImports > 0 &&
                `${removedImports} @import ${removedImports === 1 ? 'rule was' : 'rules were'} removed.`,
              removedUrls > 0 &&
                `${removedUrls} url() ${removedUrls === 1 ? 'reference was' : 'references were'} removed for pointing somewhere other than a data: URI.`,
              removedMarkup > 0 && 'A `</` sequence was removed.',
              cssReport.truncated && 'The text was cut at the size limit.',
            ]
              .filter(Boolean)
              .join(' ')}
        </p>

        <div className="actions">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={customCss === ''}
            onClick={onClearCss}
          >
            Remove my stylesheet
          </button>
        </div>

        <Message notice={notice} />
      </div>
    </>
  );
}
