# Plugin architecture — refactor plan

Status: **proposal, not started.** Nothing here is implemented.

## Decisions taken

| # | Decision |
| --- | --- |
| 1 | Split bundles only where the payload is worth it (>~20 kB). Everything else is runtime-gated. |
| 2 | A plugin can be toggled without reloading the page. Teardown must be honest; a plugin that cannot detach cleanly is a bug. |
| 3 | The API is internal, but **built to public-API standard**: versioned, documented, defensive, error-isolated. |
| 4 | **No settings migration.** The extension is not published; the storage shape can change freely. |

## Why

Every feature wires itself into the shell by hand. Measured in the tree today:

| Symptom | Measured |
| --- | --- |
| `Viewer.tsx` is a manual wiring list | 20 `settings.` gates, one JSX block per feature |
| Features each find the document body | 4 components query `.mdv-body`, 3 run their own `MutationObserver` |
| "Is the raw view showing" re-derived per feature | referenced in 5 components |
| Overlays pick their own stacking | `inset: 0` in 4 features; z-index `40`, `2147482000`, `2147483000` (twice) |
| Focus traps hand-rolled | 5 components implement their own trap and restore |
| `lib/config.ts` is a god-module | 1,489 lines: activation rules, DOM ids, add-on table, settings, theme palettes, diff and search constants |
| Options page hand-written per feature | 1,803 lines, 10 bespoke sections |
| Cross-feature calls invented ad hoc | `lib/commands.ts` holds a module-scope registry so the folder browser can reach a sibling |

Adding a feature means touching `Viewer.tsx`, `config.ts`, `options/App.tsx` and
often `Sidebar.tsx` — four files that each know about every feature.

## Goal

A feature is one object in one array. Loading is one call. Disabling it in
settings means its code never runs: no listeners, no DOM passes, no Web Worker,
no Fuse index.

---

## 1. The plugin

```ts
export interface Plugin<S extends SettingsSchema = SettingsSchema> {
  /** Stable identity. Also the settings key — renaming is a breaking change. */
  id: string;
  name: string;
  description: string;
  apiVersion: typeof PLUGIN_API_VERSION;

  enabledByDefault: boolean;
  /** Load order only. Behaviour goes through capabilities, never imports. */
  after?: string[];

  /** This plugin's own settings, their defaults, and how to render controls. */
  settings?: S;

  /** Regions this plugin publishes for others to fill. */
  provides?: string[];

  /** Declarative UI. See §2. */
  ui?: UiContribution[];

  /** Parser extension, applied at parser construction. */
  markdownIt?: (md: MarkdownIt, ctx: PluginContext<S>) => void;

  /** Imperative work: listeners, observers, capabilities, commands, shortcuts. */
  setup?: (ctx: PluginContext<S>) => Teardown | void | Promise<Teardown | void>;
}
```

Three concerns, kept separate on purpose:

- **setup / teardown** — imperative lifecycle. `setup` returns the teardown, so
  the two cannot drift apart the way a `setup`/`destroy` pair can.
- **ui** — declarative. The host decides *where* and *when* to mount; the plugin
  only says what it contributes.
- **markdownIt** — pipeline extension, applied once when the parser is built.

### The context

```ts
interface PluginContext<S> {
  settings: TypedSettings<S>;          // own settings, live, typed from the schema
  global: GlobalSettings;              // shared settings; see §4
  document: DocumentHandle;            // the rendered document and its lifecycle
  ui: UiHost;                          // overlays, imperative mounts
  commands: CommandRegistry;
  shortcuts: ShortcutRegistry;
  capabilities: CapabilityRegistry;    // typed cross-plugin calls
  addon: AddonLoader;                  // heavy code, injected on demand
  logger: Logger;                      // namespaced; errors surface to the host
}
```

`DocumentHandle` is the single answer to the four components that each locate
`.mdv-body` and the three that each observe it:

```ts
interface DocumentHandle {
  readonly body: HTMLElement | null;
  readonly source: string;
  readonly headings: Heading[];
  readonly url: string;
  readonly isRaw: boolean;

  /** Fires after every render, live reload and raw toggle. One shared observer. */
  onChange(fn: (body: HTMLElement) => void): Teardown;

  /**
   * A pass over the rendered body, batched with every other plugin's into one
   * post-paint frame. The teardown must undo whatever the pass added.
   */
  enhance(pass: (body: HTMLElement) => Teardown | void): Teardown;
}
```

---

## 2. Rendering — the region model

This is the part that decides whether the architecture holds. A plugin must be
able to render into the sidebar, into a corner, above the document, as a modal —
without the shell knowing the plugin exists, and without the plugin knowing the
shell's DOM.

### Regions are named mount points, and they are themselves contributed

The **core shell** publishes only regions that follow from its own layout, never
from a feature:

| Region | Where |
| --- | --- |
| `chrome.top-start` `chrome.top-end` | floating chrome, top corners |
| `chrome.bottom-start` `chrome.bottom-end` | floating chrome, bottom corners |
| `document.before` `document.after` | inside the document column, around the body |
| `settings.section` | the options page |

Everything else is published **by the plugin that owns that surface**:

```ts
// the sidebar plugin
provides: ['sidebar.tab', 'sidebar.panel'],
// the status bar plugin
provides: ['statusbar.start', 'statusbar.end'],
```

So the outline, files and search plugins contribute to `sidebar.tab`, which
exists only while the sidebar plugin is enabled. **A contribution to a region
that does not exist is inert** — not an error, not a crash, nothing rendered.
That is the honest behaviour when a reader disables the sidebar, and it falls
out of the design rather than needing a special case.

Regions render through a host-provided component, available to plugins so they
can publish regions inside their own markup:

```tsx
<Region name="sidebar.tab" />
```

### A contribution

```ts
interface UiContribution {
  region: string;
  /** Stable within a plugin; the React key and the debug handle. */
  key: string;
  /** Lower renders first. Default 100; ties broken by registry order. */
  order?: number;
  component: ComponentType;
}
```

Conditional rendering is the component's own business — it reads
`useDocument().isRaw` and returns `null`. That keeps the host from re-inventing
React's own conditional rendering with a `when` predicate.

**Imperative escape hatch.** Add-on-style code (mermaid, katex) is DOM code, not
React. `ctx.ui.mount(region, el => Teardown)` wraps an imperative mount in a host
component. Documented as the exception, not the norm — if most plugins reach for
it, the region set is wrong.

### Overlays are managed, not positioned

Four features currently do `inset: 0` with hand-picked z-indexes, three of them
within 1000 of each other, and five components hand-roll a focus trap. Nested
modals (palette → export, search → jump) are undefined behaviour today.

```ts
const handle = ctx.ui.overlay.open({
  id: 'lightbox',
  component: LightboxView,
  modal: true,
  onClose,
});
```

The host guarantees, once, for everyone:

- **stacking by stack position** — no magic z-indexes anywhere in plugin CSS
- **only the top overlay is interactive**; everything below is `inert`
- **Escape closes the top overlay only**
- **focus trapped in the top overlay, restored precisely on close**
- `#mdv-root` inert while any modal is open
- opening an overlay from an overlay works and unwinds in order

This deletes five focus-trap implementations and replaces four magic numbers
with one rule.

### Why declarative UI rather than a `render()` method

A `render()` on the plugin would make the plugin responsible for *where* it
lands, which is exactly the coupling being removed. Contributions name a region
and hand over a component; placement, ordering, mounting and unmounting are the
host's. It also makes an enabled/disabled toggle trivial: the host stops
rendering the contribution, React unmounts it, and the component's own effects
clean up — no separate teardown path for UI.

---

## 3. Capabilities — how plugins reach each other

Replaces the module-scope registry in `lib/commands.ts` and the props the
command palette currently cannot be given.

```ts
// provider
ctx.capabilities.provide('export', {
  formats: () => ExportFormat[],
  run: (format: ExportFormat) => Promise<ExportResult>,
});

// consumer
const exporter = ctx.capabilities.use('export');   // undefined when disabled
if (exporter) ctx.commands.add({ id: 'export.html', … });
```

Capability names and their types live in one declaration file, so `use()` is
typed and a typo is a compile error. **Absence is a normal state**, never an
error — which is already how the palette wants to behave (it drops a row rather
than listing a dead action), expressed once instead of at each call site.

---

## 4. Settings — global and per-plugin

```ts
{
  version: 3,
  global: {
    theme, themePreset, customCss,
    fontFamily, fontSize, lineHeight, contentWidth,
  },
  plugins: {
    [id]: { enabled: boolean, ...ownSettings },
  },
}
```

**Global** settings are the ones no single plugin owns: theme and typography
affect the document itself and are read by many plugins. **Plugin** settings
belong to exactly one plugin and are namespaced under its id, so two plugins can
both have a `mode` without colliding.

Access rules, deliberately asymmetric:

- `ctx.settings` — read/write **its own** settings, typed from its schema.
- `ctx.global` — read shared settings freely; **writing is allowed but explicit**
  (`ctx.global.set({ theme })`). Some plugins legitimately act on the user's
  behalf — the command palette's "toggle theme" is the obvious case — and
  pretending otherwise would just push it into a capability that does the same
  thing with more ceremony.

A schema declares type, default, and how to render the control:

```ts
settings: {
  splitOn: {
    type: 'enum',
    options: SLIDE_SPLIT_OPTIONS,
    default: 'auto',
    label: 'Split slides on',
    description: 'Horizontal rules, headings, or whichever the document has.',
  },
}
```

`TypedSettings<S>` maps the schema to a typed object, so `ctx.settings.splitOn`
is `'auto' | 'rule' | 'heading'` with no cast.

The options page becomes: a **General** section for globals, then one generated
section per plugin with its enable switch at the top and its controls beneath.
`lib/settings-io.ts` validates imports by walking the registry, so a new plugin
is validated without touching it. `entrypoints/options/App.tsx` drops from 1,803
lines to a renderer plus the genuinely bespoke panels (permissions, folders,
backup).

---

## 5. Bundle strategy

Two levels, and only one is free — this is settled but worth restating because
it constrains the registry shape.

**Runtime gating (every plugin, no cost).** `setup()` is not called and its `ui`
contributions are not rendered. No listeners, no observers, no Worker, no Fuse
index. This is what "the logic never runs" means, and it is delivered for
everything.

**Bundle splitting (heavy plugins only).** Not achievable with `import()` here:
WXT builds unlisted scripts in Vite library mode as a single-entry IIFE, which
forces `inlineDynamicImports`. Proven twice — `fuse.js` sits in `renderer.js`
today *despite* `await import()`, and deferring KaTeX needed a resolver-level cut
rather than a renderer-rule change. Real splitting needs a separate entrypoint
injected via `chrome.scripting`, which is what `ADDONS` already does.

Per decision 1, split only where the payload earns it:

| Split today | Size |
| --- | --- |
| `mermaid-addon.js` | 3.3 MB |
| `export-addon.js` | 748 kB |
| `katex-addon.js` | 288 kB |
| `diff-addon.js` | 15 kB |

To split next: **Fuse** (~26 kB) and the **search worker** (~4 kB blob), because
both are named in the request as things that must not exist when their plugin is
off. Everything else stays in `renderer.js` (692 kB) and is runtime-gated.

In the registry this is one optional field, so the two tiers look the same to a
plugin author:

```ts
{ id: 'mermaid', addon: 'mermaid-addon.js', … }
```

---

## 6. Public-API standards (decision 3)

Treated as public even though it is internal:

- **Error isolation.** `setup`, `teardown` and `markdownIt` run inside try/catch;
  a throwing plugin is disabled, reported, and the viewer keeps working. Every
  UI contribution is wrapped in an error boundary, so one broken component
  cannot blank the document. *This does not exist today — a throw anywhere in the
  tree takes the whole viewer down.*
- **Versioned.** `PLUGIN_API_VERSION`; a plugin declaring a different major is
  refused with a clear message rather than failing mysteriously.
- **No global mutable state.** Everything through the context. `lib/commands.ts`'s
  module-scope registry is the anti-pattern being removed.
- **Deterministic ordering.** Explicit `order`, ties broken by registry index —
  never by import side effects.
- **Documented.** `docs/plugin-api.md`: every extension point, the teardown
  contract, and a complete worked example.
- **Tested as a contract.** A host test enables and disables every plugin in a
  loop and asserts no listeners, observers, portals, stylesheets, custom
  highlights or DOM residue survive.

---

## 7. Layout

```
lib/plugins/
  types.ts            Plugin, PluginContext, contributions, settings schema
  host.ts             load, enable, disable, teardown, error isolation
  context.ts          the context implementation
  regions.tsx         Region component and registry
  overlays.tsx        the overlay stack: z-order, inert, focus, Escape
  capabilities.ts     typed provide/use
  settings.ts         schema → typed settings, defaults, validation
  index.ts            PLUGINS: Plugin[]

plugins/
  outline/  files/  search/  quick-find/  command-palette/
  code-copy/  heading-anchors/  heading-fold/  external-links/
  lightbox/  reading-status/  presentation/  diff/
  mermaid/  math/  export/  frontmatter/  sortable-tables/
  broken-links/  hover-previews/  scroll-memory/  live-reload/
```

Each plugin directory holds its own component(s), CSS, settings schema and
tests — so a feature is one folder, not seven edits across shared files.

---

## 8. Migration order

Strangler, not big-bang. 363 tests are the safety net; `npm run verify` stays
green at every step, and each step is its own commit.

0. **Browser pass first.** See §9 — this is a genuine precondition, not a
   formality.
1. **Host, types, regions, overlays.** Nothing migrated; the shell still wires by
   hand. Tests: enable, disable, teardown residue, missing region, missing
   capability, load order, a plugin that throws.
2. **Three pilots, deliberately different shapes** — `external-links` (pure
   enhancement pass, no UI, no settings), `presentation` (overlay + settings +
   shortcut), `outline` (contributes a region *and* fills one). If the interface
   survives all three, it is close to right. If not, this is the cheap moment.
3. **Enhancement-pass plugins**: code copy, heading anchors, heading fold,
   reading status, lightbox. The `DocumentHandle` payoff lands here.
4. **Overlay plugins**: quick find, search panel, command palette, diff, export.
   The overlay manager replaces five focus traps and four magic z-indexes.
5. **Sidebar**: becomes a plugin providing `sidebar.tab`; outline, files and
   search become contributions.
6. **Pipeline plugins**: footnotes, emoji, alerts, containers, tables, anchors,
   math tokenizer, mermaid fence, wikilinks. Order matters — the
   code-span-beats-math rule exists because of it — so each gets its own test.
7. **Shell behaviours**: scroll memory, live reload, shortcuts, theme.
8. **Generate the options page**, restructure settings storage, delete the dead
   wiring, shrink `lib/config.ts` to activation/DOM/build constants.
9. **Then** build the outstanding v1.3 features (#15 frontmatter, #18 sortable
   tables / broken links / hover previews) as plugins — rather than building
   them now and porting them twice.

Steps 1–2 decide whether the design is right. Everything after is mechanical.

---

## 9. Risks

- **Nothing has run in a real browser.** Not Bucket 3, not Bucket 4, not v1.3.
  The suite covers logic well and UI barely at all. Refactoring on unverified
  foundations makes every future bug ambiguous — did the refactor break it, or
  was it always broken? **A `npm run dev` pass before step 1 is the single
  highest-value thing available**, and it is cheap.
- **Teardown is where this leaks.** Listeners, observers, portals, injected
  stylesheets, CSS custom highlights, worker termination. Mitigated by the
  contract test in §6, which is worth writing before the plugins it polices.
- **Region design is a one-way door in practice.** Too few and plugins hardcode
  around them; too many and the shell knows about features again. The three
  pilots in step 2 exist specifically to test this before 20 plugins depend on it.
- **Pipeline ordering is real coupling.** markdown-it rule order already matters.
- **Per-plugin CSS.** All feature CSS currently lands in `assets/renderer.css`
  regardless of enablement. Splitting means more stylesheets and more
  `check:build` surface; not splitting means disabled plugins still ship CSS.
  Recommendation: one stylesheet initially, revisit with measurements.
- **Scope.** This touches nearly every file. Steps 1–2 stand on their own and can
  be stopped after if the shape proves wrong.
