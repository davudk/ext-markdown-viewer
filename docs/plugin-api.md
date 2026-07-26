# Plugin API

Every feature in the viewer is a plugin. This is the contract.

The API is internal — there is no third-party plugin store — but it is written
to a public standard: versioned, defensive, and documented, because the cost of
a sloppy internal interface is paid every time a feature is added.

## A plugin

```ts
import { PLUGIN_API_VERSION, type Plugin } from '../../lib/plugins/types.ts';

const settings = {
  showIndicator: {
    type: 'boolean',
    default: true,
    label: 'Mark links that leave the document',
  },
} as const;

export const externalLinksPlugin: Plugin<typeof settings> = {
  id: 'external-links',
  name: 'External link indicators',
  description: 'Shows which links lead away from the document.',
  apiVersion: PLUGIN_API_VERSION,
  enabledByDefault: true,
  settings,

  setup(ctx) {
    const stop = ctx.document.enhance((body) => {
      markExternalLinks(body, ctx.document.url);
      return () => clearExternalLinks(body);
    });
    return stop;
  },
};
```

Register it in `lib/plugins/index.ts`. That is the whole installation step.

### Import style

Plugins import with **relative paths and explicit extensions** (`../../lib/x.ts`),
not the `@/` alias. Tests run under bare node with `--experimental-strip-types`,
which has no bundler to resolve an alias — and a plugin that cannot be unit
tested is not worth the abstraction. The same rule applies under `lib/`.

## The three concerns

| Field | For | Runs |
| --- | --- | --- |
| `setup(ctx)` | listeners, observers, capabilities, commands, shortcuts | on enable |
| `ui` | declarative contributions | while enabled |
| `markdownIt(md, ctx)` | parser extensions | at parser construction |

`setup` returns its own teardown rather than pairing with a `destroy` method, so
the two cannot drift apart: whatever the closure captured is exactly what the
teardown sees.

## Teardown is the contract

**A plugin can be toggled without reloading the page.** Everything `setup`
registers through `ctx` is tracked and unwound automatically — commands,
shortcuts, capabilities, overlays, enhancement passes. Anything you attach
yourself, you return.

A plugin that cannot detach cleanly is a bug, not a quirk. `test/plugins.test.ts`
toggles plugins repeatedly and asserts nothing accumulates; that failure mode
(register on every enable, remove once) looks fine until the third toggle.

## Rendering

There is no `render()` method, deliberately: it would make the plugin
responsible for *where* it lands, which is the coupling this design removes.
Instead a plugin contributes components to **named regions**.

```ts
ui: [{ region: 'chrome.bottom-end', key: 'launcher', order: 50, component: Launcher }]
```

Core regions, named for where they are and never for what fills them:

`chrome.top-start` · `chrome.top-end` · `chrome.bottom-start` ·
`chrome.bottom-end` · `document.before` · `document.after` · `settings.section`

**Regions are themselves contributed.** A plugin owning a surface publishes its
own with `provides: ['sidebar.tab']` and renders `<Region name="sidebar.tab" />`
inside its markup. So `sidebar.tab` exists exactly while the sidebar does — and
**a contribution to a region that does not exist is inert**: nothing renders, no
error. That is the correct behaviour when a reader disables the surface that
owned it, and it needs no special case in the contributing plugin.

Ordering is `order` (default 100), ties broken by registry position — never by
import side effects.

### Reaching your own context

A contribution is declared on the plugin object, before any context exists, so
it cannot close over one. The host renders each contribution inside a provider:

```tsx
function Launcher() {
  const ctx = usePlugin<typeof settings>();
  const settings = usePluginSettings<typeof settings>();  // re-renders on change
  const doc = useDocument();
  ...
}
```

### Parser extensions

`markdownIt(md, ctx)` runs once, when the parser is built. `lib/markdown.ts`
calls `host.applyMarkdownIt(md)` and keeps only what is not optional: the
`MarkdownIt` construction, the `<pre>` markup, task lists and table alignment
(baseline GFM the export reads unconditionally), DOMPurify, and the
`{ html, headings }` contract. Every *syntax* is a plugin.

The shell hands the pipeline its host once, at startup:

```ts
setMarkdownHost(host);   // lib/markdown.ts
```

Two rules follow from the fact that plugins are applied in load order:

**Order against a rule, never against a plugin.** markdown-it's rulers position
by name — `inline.ruler.before('link', …)`, `core.ruler.push(…)`. A rule
inserted relative to a *core* rule (`link`, `math_inline`) cannot be broken by a
registry edit. `after: [...]` only decides who is applied first, and load order
is exactly the thing a merge reorders without anyone noticing.

**Keep coupled rules in one `markdownIt`.** `mdv_code_span_wins` must run before
`math_inline`, so both are installed by `markdown-math` in that order, in one
function. Splitting them into two plugins ordered by `after:` would express the
same coupling in the one place the host is free to ignore it.

`test/markdown-order.test.ts` renders every case the ordering is load-bearing
for with the registry reversed and shuffled, and asserts the output is
byte-identical. A new markdown plugin belongs in its `CASES`.

Sanitization runs after every plugin, so no plugin can widen what reaches the
DOM. `PURIFY_CONFIG` allows `svg` for the alert icons; nothing needs it wider.

### Overlays

Never position a modal yourself.

```ts
const handle = ctx.ui.openOverlay({ id: 'deck', label: 'Presentation', component: Deck });
```

The host owns stacking (position in the stack, not a number anyone picks),
`inert` on everything beneath, focus trapping, focus restore, and Escape closing
only the top. Before this, four features used `inset: 0` with hand-picked
z-indexes — `40`, `2147482000`, and `2147483000` twice — and five components
each wrote their own focus trap.

### Imperative mounting

`ctx.ui.mount(region, el => teardown)` exists for DOM code that is not React
(the add-ons). It is the exception. If most plugins reach for it, the region set
is wrong and should be fixed instead.

## The document

One shared handle replaces the four independent `.mdv-body` lookups and three
`MutationObserver`s that preceded it.

```ts
ctx.document.body / .source / .headings / .url / .isRaw
ctx.document.onChange(fn)   // after every render, live reload and raw toggle
ctx.document.enhance(pass)  // batched into one post-paint frame
ctx.document.refresh()      // re-run passes against the same document
```

`enhance` passes may return a teardown; the host runs it before each re-run and
on disable, so a pass that grafts nodes removes exactly those nodes rather than
guessing later. A **new body drops stale teardowns** rather than running them
against detached nodes.

`refresh()` exists because a plugin whose own *setting* changed needs its pass
reapplied to the same document — without it, every plugin would grow the
observer `enhance` exists to remove.

## Settings

Global settings describe the document (theme, typography) and are read by many
plugins. Plugin settings are namespaced under the plugin id, so two plugins can
both own a `mode`.

```ts
ctx.settings.showIndicator          // live, typed from the schema
ctx.updateSettings({ … })           // writes only your own namespace
ctx.onSettingsChange(fn)
ctx.global.current / ctx.global.set({ theme })
```

Writing globals is allowed but explicit — the command palette's "toggle theme"
acts on the user's behalf, and routing that through a capability would be the
same act with more ceremony.

Stored values are coerced against the schema on read: out of range clamps,
wrong type falls back to the default. A settings file is user-supplied input.

### Owning a global

A global is shared storage, but it is still *configured* somewhere, and that
somewhere should be the plugin whose behaviour it describes — a theme setting
three cards away from the Theme plugin is the coupling the plugin split exists
to remove. A plugin that owns globals says so by exporting the keys next to the
code that applies them:

```ts
export const THEME_GLOBALS = ['theme', 'themePreset', 'customCss'] as const
  satisfies readonly (keyof Settings)[];
```

The options page reads those exports (`entrypoints/options/owned.ts`) and
renders the rows inside that plugin's section, and fails to compile if a key in
`Settings` is claimed by nobody. Ownership does not move the value: the seven
globals stay in `lib/config.ts` because `entrypoints/renderer.tsx` resolves the
theme before any plugin exists, and must keep doing so on every path — including
the ones where the theme plugin is disabled or threw.

There is no `ownedGlobals` field on `Plugin` yet. Two plugins is not enough to
widen the API for; add one when a third needs it.

## Talking to other plugins

Never import another plugin. Use capabilities, which are typed by declaration
merging and may legitimately be absent:

```ts
ctx.capabilities.provide('export', { formats, run });
const exporter = ctx.capabilities.use('export');   // undefined when disabled
if (exporter) ctx.commands.add({ … });
```

**Absence is a normal state, never an error.** A palette that drops a row is
correct; one that lists an action doing nothing is not.

`after: ['export']` orders *loading* only. It is not a dependency on behaviour,
and a missing or cyclic `after` is reported and ignored rather than fatal.

## Failure

Nothing a plugin does can take the viewer down.

- `setup`, teardown and `markdownIt` run inside a boundary. A throwing plugin is
  disabled and reported; its siblings still load.
- A plugin that throws **mid-setup** has whatever it already registered unwound,
  so it leaves nothing behind.
- A throwing **teardown** does not block the remaining teardowns.
- Every UI contribution is wrapped in an error boundary — one broken component
  cannot blank the document the reader came for.
- A wrong `apiVersion` is refused with a clear message rather than run.

## Heavy code

Runtime gating is free and automatic: disabled means `setup` never runs, so no
worker is constructed and no index is built.

Bundle splitting is not free. `import()` does **not** split here — WXT builds
unlisted scripts as single-entry IIFEs, forcing `inlineDynamicImports`. Real
splitting needs a separate entrypoint injected via `chrome.scripting`:

```ts
{ id: 'mermaid', addon: 'mermaid-addon.js', … }
```

Worth it above roughly 20 kB; below that the injection round-trip costs more
than the bytes saved.

## Checklist for a new plugin

- [ ] `id` is stable — it is the settings key, and renaming it is breaking
- [ ] relative imports with explicit extensions
- [ ] everything registered outside `ctx` is returned as a teardown
- [ ] a test that enables, disables, and asserts no residue
- [ ] no z-index, no focus trap, no `MutationObserver` on the body
- [ ] no import of another plugin
- [ ] `data-mdv-chrome` on screen-only UI; `--mdv-*` tokens only
