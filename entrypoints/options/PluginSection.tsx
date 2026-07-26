/**
 * One card per plugin, generated from the registry.
 *
 * Nothing here knows what any particular feature is: the name, the description
 * and every control come from the plugin's own declaration. Adding a setting to
 * a plugin adds a control to this page, and there is no second place to forget
 * to edit — which is the whole reason the schema exists.
 */

import { Message, Row, Segmented, Select, Slider, Switch } from './controls';
import { isPluginEnabled, settingEntries, type AnyPlugin, type SettingEntry, type StoredSettings } from './plugins';

/** Above this many choices a row of segments stops being readable. */
const SEGMENT_LIMIT = 4;

/**
 * How a control reports a change. `defer` asks for the debounced write used by
 * the sliders and text fields, which fire on every pixel and every keystroke.
 */
export type SettingChange = (key: string, value: unknown, defer?: boolean) => void;

function PluginSetting({
  entry,
  id,
  change,
}: {
  entry: SettingEntry;
  /** Unique across the page: the plugin id and the setting key together. */
  id: string;
  change: SettingChange;
}) {
  const { definition } = entry;
  const describedBy = definition.description ? `${id}-desc` : undefined;

  // The one switch that narrows `definition` and `value` together — see
  // `SettingEntry`. Every branch below is typed, with no cast.
  switch (entry.type) {
    case 'boolean':
      return (
        <Row
          id={id}
          title={definition.label}
          description={definition.description}
          control={
            <Switch
              on={entry.value}
              busy={false}
              disabled={false}
              labelledBy={`${id}-label`}
              describedBy={describedBy ?? `${id}-label`}
              onChange={(next) => change(entry.key, next)}
            />
          }
        />
      );

    case 'number': {
      const number = entry.definition;
      const value = entry.value;
      const unit = number.unit ? ` ${number.unit}` : '';
      return (
        <Row
          id={id}
          title={definition.label}
          description={definition.description}
          control={
            <Slider
              id={id}
              value={value}
              display={`${value}${unit}`}
              valueText={`${value}${unit || ''}`}
              range={{ min: number.min, max: number.max, step: number.step ?? 1 }}
              // Deferred: a drag fires this on every pixel of travel.
              onChange={(next) => change(entry.key, next, true)}
            />
          }
        />
      );
    }

    case 'enum': {
      const options = entry.definition.options;
      const value = entry.value;
      return (
        <Row
          id={id}
          title={definition.label}
          description={definition.description}
          control={
            options.length <= SEGMENT_LIMIT ? (
              <Segmented
                name={id}
                value={value}
                options={options}
                labelledBy={`${id}-label`}
                describedBy={describedBy}
                onChange={(next) => change(entry.key, next)}
              />
            ) : (
              <Select
                id={id}
                value={value}
                options={options}
                describedBy={describedBy}
                onChange={(next) => change(entry.key, next)}
              />
            )
          }
        />
      );
    }

    case 'string': {
      const string = entry.definition;
      const value = entry.value;
      const described = [describedBy, `${id}-count`].filter(Boolean).join(' ');

      return (
        <div className="row row-stack">
          <label className="row-title" htmlFor={id}>
            {definition.label}
          </label>
          {definition.description !== undefined && (
            <p className="row-desc" id={`${id}-desc`}>
              {definition.description}
            </p>
          )}

          {string.multiline ? (
            <textarea
              id={id}
              className="editor"
              rows={5}
              spellCheck={false}
              value={value}
              maxLength={string.maxLength}
              aria-describedby={described || undefined}
              onChange={(event) => change(entry.key, event.target.value, true)}
            />
          ) : (
            <input
              id={id}
              type="text"
              className="field"
              value={value}
              maxLength={string.maxLength}
              aria-describedby={described || undefined}
              onChange={(event) => change(entry.key, event.target.value, true)}
            />
          )}

          {string.maxLength !== undefined && (
            <p className="editor-count" id={`${id}-count`}>
              {value.length.toLocaleString()} of{' '}
              {string.maxLength.toLocaleString()} characters
            </p>
          )}
        </div>
      );
    }
  }
}

export function PluginSection({
  plugin,
  stored,
  failure,
  onToggle,
  onSetting,
}: {
  plugin: AnyPlugin;
  stored: StoredSettings;
  /** Why the host disabled it last time it ran, if it did. */
  failure?: string;
  onToggle: (enabled: boolean) => void;
  onSetting: SettingChange;
}) {
  const enabled = isPluginEnabled(plugin, stored);
  const entries = settingEntries(plugin, stored);
  const headingId = `plugin-${plugin.id}-h`;

  return (
    <section className="card" aria-labelledby={headingId}>
      <div className="card-head">
        <h2 id={headingId}>{plugin.name}</h2>
      </div>

      <Row
        id={`plugin-${plugin.id}-enabled`}
        title="Enabled"
        description={plugin.description}
        control={
          <Switch
            on={enabled}
            busy={false}
            disabled={false}
            labelledBy={`plugin-${plugin.id}-enabled-label`}
            describedBy={`plugin-${plugin.id}-enabled-desc`}
            onChange={onToggle}
          />
        }
      />

      {/* A feature that vanished without explanation is worse than one that is
          off, so say what happened rather than leaving the switch looking on
          while nothing happens. */}
      {failure !== undefined && (
        <div className="row row-quiet">
          <Message
            notice={{
              tone: 'error',
              text: `This stopped working the last time a document was open and was switched off to keep the rest of the page working — ${failure}. It will be tried again on the next document.`,
            }}
          />
        </div>
      )}

      {/* Settings stay visible while disabled rather than disappearing: the
          section would otherwise change height under the reader's cursor, and
          a setting is worth adjusting before turning something back on. */}
      {entries.map((entry) => (
        <PluginSetting
          key={entry.key}
          entry={entry}
          id={`plugin-${plugin.id}-${entry.key}`}
          change={onSetting}
        />
      ))}
    </section>
  );
}
