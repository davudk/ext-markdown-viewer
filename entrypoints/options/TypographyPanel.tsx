/**
 * The typography plugin's own settings: font, size, line height and measure.
 *
 * Same move as `ThemePanel` and for the same reason — these describe what the
 * typography plugin does, so they are configured in its section. The values
 * stay in `Settings`, because the export plugin, the presentation deck and the
 * reading-time estimate all read them; see `owned.ts`.
 *
 * Three of the four would generate cleanly from a schema, and one — the preview
 * — would not, and the four belong together. Written out of the same pieces the
 * generated rows use, so a reader cannot tell which is which.
 */

import type { CSSProperties } from 'react';

import {
  CONTENT_WIDTH_CH,
  CONTENT_WIDTH_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_RANGE,
  FONT_STACKS,
  LINE_HEIGHT_RANGE,
  VIEWER_CSS_VARS,
} from '@/lib/config';
import type { Settings } from '@/lib/settings';

import { Message, Segmented, Slider, type Notice } from './controls';

export type Reading = Pick<
  Settings,
  'fontFamily' | 'fontSize' | 'lineHeight' | 'contentWidth'
>;

/** `1.65` on its own reads as nothing in a screen reader; this says what it is. */
function lineHeightText(value: number): string {
  return `${value.toFixed(2)} times the font size`;
}

/**
 * The step is 0.05, and repeated float addition drifts (1.7000000000000002),
 * which would leak into both the label and storage. Two decimals is the most
 * the range can express.
 */
export function roundLineHeight(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The same four custom properties the typography plugin writes on the document
 * root. Duplicated rather than shared because the two live in different bundles
 * and the mapping is one line each; VIEWER_CSS_VARS is the part that must not
 * drift, and that is imported.
 */
function previewVars(reading: Reading): CSSProperties {
  return {
    [VIEWER_CSS_VARS.fontFamily]: FONT_STACKS[reading.fontFamily],
    [VIEWER_CSS_VARS.fontSize]: `${reading.fontSize}px`,
    [VIEWER_CSS_VARS.lineHeight]: String(reading.lineHeight),
    [VIEWER_CSS_VARS.contentWidth]: CONTENT_WIDTH_CH[reading.contentWidth],
  } as CSSProperties;
}

export function TypographyPanel({
  reading,
  notice,
  onChange,
  onReset,
}: {
  reading: Reading;
  notice: Notice | null;
  /** `defer` asks for the debounced write the sliders need. */
  onChange: (patch: Partial<Reading>, defer?: boolean) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="row">
        <div className="row-text">
          <h3 className="row-title" id="font-label">
            Font
          </h3>
          <p className="row-desc">
            Fonts already on this computer. The extension never downloads one,
            so nothing here reaches the network.
          </p>
        </div>

        <Segmented
          name="font-family"
          value={reading.fontFamily}
          options={FONT_FAMILY_OPTIONS}
          labelledBy="font-label"
          onChange={(value) => onChange({ fontFamily: value })}
        />
      </div>

      <div className="row">
        <div className="row-text">
          <h3 className="row-title" id="font-size-label">
            Font size
          </h3>
          <p className="row-desc">
            The base size for body text. Headings, code and captions are sized
            in proportion to it, so they all move together.
          </p>
        </div>

        <Slider
          id="font-size"
          value={reading.fontSize}
          display={`${reading.fontSize}px`}
          valueText={`${reading.fontSize} pixels`}
          range={FONT_SIZE_RANGE}
          // Deferred: a drag fires this on every pixel of travel.
          onChange={(next) => onChange({ fontSize: next }, true)}
        />
      </div>

      <div className="row">
        <div className="row-text">
          <h3 className="row-title" id="line-height-label">
            Line height
          </h3>
          <p className="row-desc">
            Space between lines, as a multiple of the font size. More helps on
            long paragraphs; less fits more on screen.
          </p>
        </div>

        <Slider
          id="line-height"
          value={reading.lineHeight}
          display={reading.lineHeight.toFixed(2)}
          valueText={lineHeightText(reading.lineHeight)}
          range={LINE_HEIGHT_RANGE}
          onChange={(next) =>
            onChange({ lineHeight: roundLineHeight(next) }, true)
          }
        />
      </div>

      <div className="row">
        <div className="row-text">
          <h3 className="row-title" id="content-width-label">
            Content width
          </h3>
          <p className="row-desc">
            How wide a line of text is allowed to get. Measured in characters
            rather than pixels, so it stays the same length of line whatever
            font size you pick. <strong>Full</strong> removes the limit.
          </p>
        </div>

        <Segmented
          name="content-width"
          value={reading.contentWidth}
          options={CONTENT_WIDTH_OPTIONS}
          labelledBy="content-width-label"
          onChange={(value) => onChange({ contentWidth: value })}
        />
      </div>

      <div className="row row-stack">
        <h3 className="row-title" id="preview-label">
          Preview
        </h3>
        {/* Rendered from the same four custom properties as a real document, so
            this is the actual result rather than an impression of it. */}
        <div
          className="preview"
          style={previewVars(reading)}
          role="group"
          aria-labelledby="preview-label"
        >
          <p className="preview-title">Notes on the estuary</p>
          <p>
            The tide runs out twice a day and leaves the whole channel bare, a
            flat grey mile of it, stitched with the tracks of birds that got
            there first.
          </p>
          <p>
            Everything worth reading is somewhere in the middle of a long
            paragraph, which is why a sample of one line tells you nothing about
            whether a setting is comfortable to read.
          </p>
        </div>

        <div className="actions">
          <button type="button" className="btn btn-quiet" onClick={onReset}>
            Reset typography to defaults
          </button>
        </div>

        <Message notice={notice} />
      </div>
    </>
  );
}
