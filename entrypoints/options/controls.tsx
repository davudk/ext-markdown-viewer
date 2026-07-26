/**
 * The page's controls, in one place.
 *
 * These were inline in `App.tsx` while every card was hand-written. The
 * generated plugin sections render the same shapes from a schema, so a control
 * defined once is what keeps a generated row and a bespoke one identical rather
 * than merely similar.
 */

import type { ReactNode } from 'react';

export type Tone = 'ok' | 'info' | 'error';
export type Notice = { tone: Tone; text: string };

/** A live region that is always in the DOM, so async results get announced. */
export function Message({ notice }: { notice: Notice | null }) {
  return (
    <p
      className={notice ? `msg is-${notice.tone}` : 'msg'}
      role="status"
      aria-live="polite"
    >
      {notice?.text ?? ''}
    </p>
  );
}

export function Skeleton({ label }: { label: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span className="bar bar-a" />
      <span className="bar bar-b" />
    </div>
  );
}

export function Unavailable() {
  return (
    <p className="row-desc">
      This page can't reach the extension right now. Reopen it from the
      extension's toolbar icon.
    </p>
  );
}

export function Switch({
  on,
  busy,
  disabled,
  labelledBy,
  describedBy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  labelledBy: string;
  describedBy: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

/**
 * A labelled range with its value beside it.
 *
 * The `<output>` is what carries the value visually; `aria-valuetext` carries
 * it to a screen reader, because a range announces only the bare number and
 * "16" or "1.65" says nothing about what it is.
 */
export function Slider({
  id,
  value,
  display,
  valueText,
  range,
  onChange,
}: {
  id: string;
  value: number;
  display: string;
  valueText: string;
  range: { min: number; max: number; step: number };
  onChange: (next: number) => void;
}) {
  return (
    <div className="slider">
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        aria-labelledby={`${id}-label`}
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {/* Hidden from the accessibility tree on purpose: `<output>` is a live
          region by default, so left exposed it would re-announce on every tick
          of a drag — on top of the range's own aria-valuetext, which already
          says the same thing. This copy is for eyes only. */}
      <output className="slider-value" htmlFor={id} aria-hidden="true">
        {display}
      </output>
    </div>
  );
}

/**
 * A row of radios styled as one control.
 *
 * `name` has to be unique across the page — radios sharing a name are one
 * group to the browser regardless of how far apart they render, and two enum
 * settings both called `mode` would otherwise deselect each other.
 */
export function Segmented<V extends string>({
  name,
  value,
  options,
  labelledBy,
  describedBy,
  onChange,
}: {
  name: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  labelledBy: string;
  describedBy?: string;
  onChange: (next: V) => void;
}) {
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className={option.value === value ? 'segment is-on' : 'segment'}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/** The same choice as `Segmented`, for lists too long to sit in a row. */
export function Select<V extends string>({
  id,
  value,
  options,
  describedBy,
  onChange,
}: {
  id: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  describedBy?: string;
  onChange: (next: V) => void;
}) {
  return (
    <select
      id={id}
      className="select"
      value={value}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value as V)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** The standard row: a title, an optional description, and a control beside it. */
export function Row({
  id,
  title,
  description,
  stack,
  control,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  /** Put the control below the text rather than beside it. */
  stack?: boolean;
  control: ReactNode;
}) {
  return (
    <div className={stack ? 'row row-stack' : 'row'}>
      <div className="row-text">
        <h3 className="row-title" id={`${id}-label`}>
          {title}
        </h3>
        {description !== undefined && (
          <p className="row-desc" id={`${id}-desc`}>
            {description}
          </p>
        )}
      </div>
      {control}
    </div>
  );
}
