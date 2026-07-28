# Design System — Decisions To Make

This document is the working surface for building a design system: one that styles
this extension and is reusable in future extensions. It is not the design system —
it is the list of decisions that produce one, each with its alternatives, the
trade-offs, and a recommendation. Resolve the decisions top to bottom; the early
ones constrain the later ones.

It is grounded in two audits of the actual codebase (July 2026): an exhaustive
inventory of every UI surface and style value in use, and a mechanical audit of
how theming, delivery, and scoping work today. The facts below are measured, not
estimated.

---

## 0. Where we stand (the audit in one page)

**What exists and is good:**

- The **document layer is well-tokenized**: 27 semantic colour tokens
  (`--mdv-bg`, `--mdv-fg-muted`, `--mdv-tk-*`…) defined per theme polarity, with
  AA contrast enforced by tests, five complete palettes (presets), and a print
  palette. Structural tokens exist for fonts, a modular type scale
  (`--mdv-scale-1..4`, ratio 1.2), two radii, one duration.
- Theme polarity is resolved **in JS** (`data-mdv-theme='light'|'dark'` on
  `<html>`), never by CSS media query — deliberate, so explicit settings and
  per-document pins win. Presets and user CSS layer over the baseline with a
  documented specificity strategy.
- A consistent scoping contract: `#mdv-root` → `.mdv-body` for the document,
  `data-mdv-chrome` marking screen-only UI (simultaneously the print strip,
  export strip, reading-time exclusion, and search exclusion).

**What does not exist:**

- **No spacing tokens** — ~78 distinct padding declarations.
- **No UI type scale** — ~40 distinct font sizes across rem, em, and px.
- **No shadow, opacity, or z-index tokens** — 8 shadows in 3 notations,
  13 opacity levels (four different values all meaning "disabled"),
  9 z-index values with the intended ladder documented only in comments.
- **No shared components** — the "small ghost icon-button" is implemented 11
  times; the "fixed corner pill" 4 times (with one drifted to opacity 0.6);
  the visually-hidden recipe 6 times; the webkit scrollbar block 4 times.
- **The options page and popup are a second, parallel design language**:
  different token names (`--fg`/`--card`/`--line` vs `--mdv-*`), different
  theme attribute (`data-theme` vs `data-mdv-theme`), different unit system
  (px vs rem/em), and they have drifted from *each other* on buttons, segmented
  controls, skeletons, and one dark surface colour.

**Hard constraints any design system must respect** (from the mechanics audit —
these are not decisions, they are facts of the architecture):

1. **No CSS load-order guarantees.** viewer.css (injected by the service worker)
   and renderer.css (bundled) can arrive in either order. Rules that could tie
   must be a class heavier — 11 files already encode this.
2. **User custom CSS must keep winning.** It is scoped to `#mdv-root .mdv-body`
   at specificity (1,1,0). Document-column selectors must stay below that, and
   no `!important` in the document column.
3. **Colour polarity stays in JS.** No `prefers-color-scheme` in viewer CSS.
4. **Zero network, ever.** System font stacks and `data:` URIs only. Enforced by
   the audit scripts (`FETCH_ALLOWLIST`, `FONT_FACE_ALLOWLIST`).
5. **Palettes must be complete and opaque** (`#rrggbb` only, both polarities,
   AA-tested). A new colour token means updating: `THEME_TOKENS`, all five
   presets, viewer.css (light + dark + print), and `EXPORT_CSS`.
6. **`--mdv-font-body/-size/-line-height/-measure` must never be declared at
   `:root` in any stylesheet** — every use site carries a `var(…, fallback)`
   that must be able to fire before React mounts.
7. **Exports are self-contained**: `EXPORT_CSS` in `lib/export.ts` is a
   hand-maintained mirror of the document styles. Every document-facing change
   is a double edit until/unless that is automated (see D14).
8. **Chrome portalled outside `#mdv-root`** (lightbox, presentation, overlays)
   cannot see tokens set inline on `.mdv` and must restate print/reduced-motion
   rules.
9. **First paint is the renderer's**: styling must be correct before `reveal()`
   on all four startup paths, or the page flashes.

---

## How to read the decisions

Each decision has an ID (D1, D2…), options labeled **A / B / C**, and a
**Recommendation**. Recommendations are starting positions, not verdicts —
overrule freely, but record the choice (see D16). Decisions marked ⚡ have a
cheap partial version worth doing regardless of the rest.

---

## Part I — Identity and architecture

### D1. Scope: what does the design system cover?

The extension has three kinds of surface: the **viewer** (takes over a web page,
must coexist with reader documents), the **extension pages** (options, popup —
normal HTML pages we fully own), and **exports/print** (static output). Today
the viewer and the extension pages are two unrelated systems.

- **A. One system, all surfaces.** Options/popup migrate onto the same tokens
  and components as the viewer. One vocabulary to learn; the settings page
  stops drifting from the viewer it configures. Cost: a real migration of two
  pages (~1,300 lines of CSS), and the viewer's constraints (rem-based, chrome
  vs document split) get imposed on pages that didn't need them.
- **B. One token layer, two component layers.** Colour/spacing/type/radius/
  motion tokens are shared everywhere; components stay per-surface (the viewer's
  corner pill has no business in the popup, and the popup's full-width button
  stack has none in the viewer). This is the layered shape most systems land on.
- **C. Viewer-only for now.** Leave options/popup as-is; design-system the
  viewer, revisit later. Cheapest, but ratifies the drift, and future
  extensions inherit the split.

**Recommendation: B.** The audit shows the two pages already *want* the same
palette (their light values are near-identical to each other) — the divergence
is accidental, not intentional. Shared tokens fix the drift where it's real
(colour, spacing, radius) without pretending a popup and a document viewer are
the same UI. This also answers reuse: future extensions take the token layer
plus whichever component layer fits.

### D2. Reuse mechanism: how do future extensions consume it?

- **A. A copy-paste folder** (`design/` with tokens.css, primitives.css, docs).
  Zero infrastructure; versioning is "copy again"; divergence between consumers
  is invisible.
- **B. An npm package** (private or public: `@davudk/design-tokens` or similar).
  Real versioning and one source of truth; costs a repo/publish workflow, and
  this extension's build is deliberately simple (WXT + no registry deps beyond
  libraries).
- **C. A separate repo, consumed as a git submodule or subtree.** Middle ground;
  submodules are famously annoying, subtrees less so.
- **D. Design-tokens-as-data** (a `tokens.json` in W3C design-tokens format, with
  a small build step emitting CSS custom properties per consumer). Most
  future-proof and tool-friendly (Figma sync, docs generation); most machinery.

**Recommendation: A now, with the file layout chosen so B is a rename later.**
There is exactly one consumer today. Structure the folder as if it were a
package (`tokens/`, `primitives/`, `README.md`, a version line at the top) and
extraction becomes mechanical when a second extension actually exists. Avoid D
until there's a tool (Figma, docs site) that wants the JSON.

### D3. Token naming: prefix and tiering

Today: `--mdv-*` (viewer), unprefixed `--fg`/`--card` (options/popup). A
reusable system's tokens shouldn't carry this extension's name.

**Prefix — pick one:**

- **A. Neutral system prefix** (`--dk-*`, `--ds-*`, `--ui-*`): the system's
  own identity, portable to any extension.
- **B. Keep `--mdv-*`** everywhere: no migration in the viewer (its ~200
  existing references stand); future extensions ship tokens named after a
  markdown viewer.
- **C. Two-level: system tokens (`--ds-*`) aliased into app tokens
  (`--mdv-accent: var(--ds-accent)`).** Cleanest in theory; in practice every
  indirection layer is a debugging tax, and CSS var chains resolve at use time
  so the cost is real in devtools legibility.

**Tiering — pick one:**

- **A. Semantic-only** (what exists now: `--mdv-accent`, `--mdv-surface` — no
  raw `--blue-600` primitives). Small vocabulary, every token answers "what is
  this for"; palette authors pick real colours per token, which is exactly how
  the five presets + contrast tests already work.
- **B. Primitive + semantic** (a `--gray-100..900` ramp under the semantic
  layer). Standard in big systems; here it fights the preset/contrast
  machinery, which validates *semantic* pairs, and nothing today needs to say
  "the same gray as X but one step darker".

**Recommendation: prefix B, tiering A.** Keep `--mdv-*`. It is short, already
everywhere, and the "mdv is this extension's name" objection matters less than
it seems: a future extension copying the tokens does a find-replace on the
prefix in one file, or simply keeps it (nothing breaks; the prefix is
namespace, not meaning). Semantic-only tiering is already proven here by the
preset system — don't add a primitive layer until a palette author actually
needs one. The options/popup tokens migrate onto the `--mdv-*` names (D11).

### D4. Source of truth: where do tokens live?

Today colour tokens live in **two** places that must agree: `viewer.css`
(baseline) and `lib/theme-presets.ts` (presets, typed `THEME_TOKENS`, contrast
tests) — plus the hand-mirrored `EXPORT_CSS`, plus the options/popup palettes.

- **A. CSS is the source** (what exists). Human-readable, zero build step;
  but nothing type-checks that viewer.css and `THEME_TOKENS` agree, and the
  export mirror is maintained by hand and by diligence.
- **B. TypeScript is the source** (`design/tokens.ts` exporting typed
  structures; a small build/codegen step emits the CSS blocks for viewer.css,
  the preset sheet, and the export stylesheet). One definition, the contrast
  tests read it directly, the export mirror becomes generated instead of
  hand-kept. Cost: a codegen step in a build that currently has only
  post-processing scripts, and CSS that is no longer edited where it lives.
- **C. TS is the source for *colour* only; spacing/type/radius/motion stay
  authored in CSS.** Colour is where the multi-target duplication and the
  test machinery already are; the structural tokens have one home (viewer.css
  `:root`) and no duplication problem.

**Recommendation: C.** It automates exactly the part that is already
duplicated four ways and tested (colour), without turning all CSS authoring
into codegen. The check can even be soft-first: a script asserting viewer.css
matches `tokens.ts` (like `check-build.mjs` does for other invariants) before
committing to generation.

---

## Part II — The scales (the missing tokens)

### D5. ⚡ Spacing scale

The single biggest gap: ~78 distinct paddings, ~35 gaps, no tokens. Two
sub-decisions:

**Base and progression:**

- **A. Base-4 geometric-ish ladder in rem:** `0.25 / 0.5 / 0.75 / 1 / 1.5 /
  2 / 3rem` (4, 8, 12, 16, 24, 32, 48px). Industry default; coarse enough to
  force convergence.
- **B. Finer ladder matching observed usage:** the audit's most-used values
  cluster at `0.15–0.2`, `0.35–0.45`, `0.6–0.75`, `1–1.2rem`. A 6-step
  `2 / 4 / 6 / 8 / 12 / 16 / 24px`-equivalent ladder loses less nuance in the
  dense chrome (sidebar rows, toolbars) where 8px steps are too coarse.
- **C. T-shirt names** (`--mdv-space-xs..xl`) vs **numeric**
  (`--mdv-space-1..7`). Numeric extends without renaming; t-shirts read better
  but "xxs" and "2xs" arguments are eternal.

**Unit policy** (this one is subtle and matters here):

- **A. Everything rem.** Uniform; but the *document* deliberately spaces in
  `em` so padding scales with the reader's chosen font size (a `code` chip's
  `0.18em 0.4em` grows with the text). Losing that regresses a real feature.
- **B. Two-domain policy, formalized:** chrome spaces in rem (tokens), the
  document body spaces in em (its own small set of em-based tokens, e.g.
  `--mdv-inline-pad: 0.18em 0.4em`). This is what the codebase already does by
  instinct; the decision is to write it down and tokenize both sides.

**Recommendation: B-numeric ladder, B two-domain units.** Roughly:
`--mdv-space-1: 0.125rem`, `-2: 0.25rem`, `-3: 0.375rem`, `-4: 0.5rem`,
`-5: 0.75rem`, `-6: 1rem`, `-7: 1.5rem`, `-8: 2rem` — then migrate chrome
paddings to the nearest step (most are within 0.05rem of one).

### D6. ⚡ UI type scale

The document has a modular scale; the chrome has 14 rem sizes + 15 em sizes.
The observed chrome sizes cluster tightly:

| Cluster | Observed | Candidate token |
|---|---|---|
| tiny labels/badges | 0.6875–0.72rem | `--mdv-text-xs` |
| secondary text | 0.74–0.78rem | `--mdv-text-sm` |
| chrome body | 0.8–0.8125rem | `--mdv-text-md` |
| prominent chrome | 0.85–0.9rem | `--mdv-text-lg` |
| panel titles | 1rem | `--mdv-text-xl` |

- **A. Five UI sizes as above**, each with a paired line-height, and the rule
  "chrome text uses a token; document text uses em relative to the reader's
  size." Migration is mostly rounding.
- **B. Fold chrome into the document's modular scale** (0.694em / 0.833em /
  1em at ratio 1.2). Mathematically tidy; but chrome must *not* scale with the
  reader's font-size setting (a 24px reader setting shouldn't blow up the
  toolbar), which is why chrome is rem-based today. This option fights that.
- **C. Do nothing; keep per-surface sizes.** The status quo, now with 40 sizes.

**Recommendation: A.** Also decide the px question here: options/popup migrate
from px to the same rem tokens (11px→xs, 13px→md, 15px→lg map almost exactly).

### D7. ⚡ Radius, elevation, and z-index

Three small ladders, all cheap, all currently ad hoc.

**Radius.** Today: `--mdv-radius-sm: 4px`, `--mdv-radius: 8px`, plus literals
2–12px and `999px` in chrome and options.

- **A. Four steps:** `-sm: 4px`, `-md: 8px`, `-lg: 12px` (cards/options),
  `-full: 999px` (pills/chips). Rename `--mdv-radius` → `--mdv-radius-md`?
  That's 11 use-site edits; alternatively keep `--mdv-radius` as the md alias.
- **B. Two steps + full.** What exists plus `999px`; options' 10–12px cards
  round down to 8. Tighter, slightly less "settings page" softness.

**Shadows/elevation.** 8 shadows, 3 notations. Elevation is also *the* place
a token earns its keep because dark themes want different (usually stronger)
shadows.

- **A. Three levels:** `--mdv-shadow-1` (switch thumbs, segment on-state),
  `-2` (dropdowns, context menus, hover cards — unify the 20px/24px pair),
  `-3` (command palette, modal dialogs). Defined per polarity.
- **B. Two levels** (popover, modal). Even tighter; the thumb/segment
  micro-shadows become borders or stay literal.

**Z-index.** The intended ladder is already documented in comments
(1 local / 20 corners / 30 dropdowns / 40 page layers / 60 palette /
100 presentation) but encoded nowhere, and mermaid still uses `2147483000`.

- **A. Token ladder:** `--mdv-z-raised: 1`, `-corner: 20`, `-dropdown: 30`,
  `-layer: 40`, `-overlay: 60`, `-top: 100`. Migrate mermaid's cover to `-top`.
- **B. Leave as comments.** (Not really defensible once A costs six lines.)

**Recommendation: A / A / A.** One note on shadows: scrims
(`rgb(0 0 0 / 0.32)` palette, `color-mix(...)` lightbox) should become a
`--mdv-scrim` token in the same pass — two surfaces, two different formulas
today.

### D8. ⚡ Motion and state opacity

**Motion.** One token (`--mdv-dur: 120ms`) plus literals 90/140/160ms and three
animation durations. Easing is always `ease` or `linear`, unstated.

- **A. Three durations + two easings:** `--mdv-dur-fast: 90ms` (progress,
  micro-state), `--mdv-dur: 120ms` (hover/fade, the default), `--mdv-dur-slow:
  180ms` (entrances: palette, slides, lightbox transform), `--mdv-ease:
  ease`, `--mdv-ease-linear`. Reduced-motion strategy stays as-is (per-sheet
  strips — required by the load-order constraint).
- **B. Single duration, period.** Force 90/140/160/180 all to 120ms. Simplest;
  entrance animations at 120ms feel abrupt, progress at 120ms feels laggy.

**State opacity.** Four values mean "disabled" (0.38/0.4/0.45/0.55), three mean
"idle affordance" (0.3/0.4/0.55), two mean "revealed on touch" (0.4/0.55/0.8).

- **A. Tokenize the semantics:** `--mdv-opacity-disabled: 0.45`,
  `--mdv-opacity-idle: 0.55` (the corner-pill resting state — also fixes the
  0.6 drift on the broken-links badge), `--mdv-opacity-faint: 0.35`
  (fold toggles, pre-hover). Pick one value per meaning and migrate.
- **B. Rethink disabled entirely** — use colour (`--mdv-fg-muted`) instead of
  opacity for disabled states, which composes better on varied backgrounds.
  More correct, more work, changes appearance.

**Recommendation: A / A.** B-opacity is worth a note in the backlog, not the
first pass.

### D9. Iconography

Inline SVG everywhere (good: zero network), but: 5 sizes (11–15px), stroke
widths 1.6 and 1.9, and the same `ICON` prelude constant copy-pasted in four
files.

- **A. An icon module:** one `lib/icons.ts` (or `design/icons.ts`) exporting
  the shared prelude + each glyph once; two size tokens (`--mdv-icon-sm: 13px`,
  `--mdv-icon-md: 15px`); stroke 1.6 everywhere. The four copies collapse.
- **B. An icon component** (`<Icon name="copy" size="sm">`): nicer in React
  surfaces, unusable in the string-built addon surfaces (mermaid) without
  duplication — which is how the four copies happened.
- **C. Leave duplicated** (the current "isolation over sharing" philosophy —
  see D10, this is really a sub-case of it).

**Recommendation: A.** Strings compose in both worlds (JSX via
`dangerouslySetInnerHTML` on a span, addons via template strings), so one
module genuinely serves all surfaces.

---

## Part III — Components and philosophy

### D10. The central tension: shared components vs deliberate duplication

This is the most important decision in the document. The codebase currently has
an explicit philosophy, stated in comments 11 times: **plugins duplicate style
recipes on purpose** ("matches the toolbar buttons by construction rather than
by sharing their class, so a change over there cannot silently restyle this").
It buys: plugin isolation (disable a plugin, its CSS is inert), no load-order
coupling, no cross-plugin restyling accidents. It costs: the drift the audit
found (opacity 0.55 vs 0.6, shadows 20px vs 24px, two focus idioms), and every
future visual change is N edits.

- **A. Tokens deep, classes shallow.** Keep per-plugin duplication of *rules*,
  but make every value in them a token. The corner pill stays written out in
  four files — but all four say `padding: var(--mdv-space-2) var(--mdv-space-3);
  opacity: var(--mdv-opacity-idle)`. Drift becomes impossible at the value
  level while isolation is fully preserved. The design system is then: tokens +
  **written recipes** (a documented "corner pill" recipe in this file's
  successor, copy-pasted deliberately).
- **B. A shared primitives stylesheet** (`design/primitives.css` bundled into
  the renderer: `.mdv-btn-ghost`, `.mdv-pill`, `.mdv-card`, `.mdv-input`…).
  One definition per primitive; plugins opt in by class. Cost: a new load-order
  surface (primitives.css is bundled, viewer.css injected — ties must still be
  avoided), and disabling a plugin no longer removes "its" styles from the
  page (minor: they're inert without the markup).
- **C. A React component library** (`<GhostButton>`, `<Pill>`, `<Panel>`).
  Strongest consistency, best DX for new plugins; but the addons (mermaid) and
  imperative enhancements (copy buttons, sort buttons, fold toggles) build DOM
  by hand outside React, so C needs A or B underneath it anyway.

**Recommendation: A now, B selectively later.** A is compatible with
everything the architecture believes in and captures ~90% of the consistency
win. Promote a recipe to a shared class (B) only when it appears a *fifth*
time or when a deliberate redesign has to touch all instances anyway. The
sr-only/live-region recipe is the one immediate exception — six identical
copies of a purely functional (never-designed) block should just be one class
today.

### D11. Unifying the options page and popup

Given D1-B (shared tokens), the concrete migration decision:

- **A. Full migration:** both pages adopt `--mdv-*` tokens, the `data-mdv-theme`
  attribute, and the JS polarity resolver (a ~20-line settings-aware script per
  page); px → rem via the D5/D6 scales; the duplicated dark-palette CSS blocks
  collapse. The two pages' components (`.btn`, `.segmented`, `.skeleton`)
  reconcile their drift as part of the move.
- **B. Palette-only migration:** keep `data-theme` + CSS-resolved auto (it
  works and is self-contained), but rename/revalue the tokens to the shared
  ones (`--fg` → `--mdv-fg`, etc.), keeping the page-specific extras
  (`--page`, `--card`, `--shadow`) as page-scoped additions.
- **C. Leave them.** (Ratifies two design languages; rejected by D1-B unless
  D1 is reopened.)

**Recommendation: B.** The CSS-resolved `auto` on extension pages is genuinely
fine — those pages don't have per-document pins or preset sheets, so the
viewer's JS-resolution rationale doesn't apply. Renaming tokens is mechanical;
adopting the viewer's resolver is machinery without a driver. Reconcile the
drifted components while touching the files. (Note: whichever way this goes,
fix the `.is-error`/`.is-err` bug first — see Part V.)

### D12. Canonical component decisions (the pick-one list)

Each row is a micro-decision; the audit found multiple live answers. Defaults
proposed; veto per-row.

| # | Component question | Options found in the wild | Proposed canonical |
|---|---|---|---|
| 12.1 | Focus ring on *inputs* | inset box-shadow ring (quick-find, palette, filter) vs `outline: 2px` (everywhere else) | **inset box-shadow for fields, outline for everything else** — the inset ring survives `overflow: hidden` corners, which is why it exists |
| 12.2 | Focus outline offset | 2 / 1 / −1 / −2 / −3 / 4 px | **2px default; −2px only inside clipped containers**; kill the rest |
| 12.3 | Disabled affordance | opacity 0.38 / 0.4 / 0.45 / 0.55 | **`--mdv-opacity-disabled: 0.45`** (D8) |
| 12.4 | Corner-pill resting opacity | 0.55 ×3, 0.6 ×1 | **`--mdv-opacity-idle: 0.55`** |
| 12.5 | Dropdown/popover shadow | 20px vs 24px blur, `/22%` vs `/0.35` | **one `--mdv-shadow-2`** |
| 12.6 | Icon button hit size | 1.15 / 1.25 / 1.5 / 1.6 / 1.65 / 1.75 / 1.85 rem | **1.65rem (26px) minimum interactive; 1.25rem allowed only inside text-density contexts (table sort)** — note even 1.65rem is below the 44px touch guideline; acceptable for a desktop-first extension, decide knowingly |
| 12.7 | Pressed/on state | accent fill (tools, toggles, chips) vs inset underline (tabs) vs left bar (rows) | **keep all three, but assign meanings**: fill = binary toggle, underline = tab selection, left bar = current-location in a list |
| 12.8 | Chip shape | `999px` pill (tags, counters) vs `radius-sm` rect (diff chips) | **pill for status/tags, rect for interactive chips** (matches current instinct) |
| 12.9 | Sticky group headers in scrollers | 3 hand-rolled variants | **one recipe** (documented, per D10-A) |
| 12.10 | Scrollbar styling | 9px (3 sheets) vs 10px (viewer) | **one recipe, 10px, tokenized thumb colour** (already is) |
| 12.11 | `@media (hover:none)` reveal | copy → 1.0, anchor → 0.4, fold → 0.55, stats → 0.8 | **one value, propose 0.55** — touch users see affordances uniformly |
| 12.12 | Corner inset | `0.6rem` as literal ×3 + two single-use vars | **`--mdv-inset-corner: 0.6rem`**, delete the two one-off vars |
| 12.13 | Empty-state block | 6 variants | **one recipe** (muted text, dashed border optional) |
| 12.14 | Alert accent mapping | note→accent, tip→addition, important→title, warning→builtin, caution→deletion | **keep** — it's coherent and token-driven; document it |

### D13. Density and the "premium" register

Style, not structure — but it decides how every token value lands. The current
UI is quiet, bordered, low-contrast-chrome, hover-revealed. A design system
should name its register so future surfaces match.

- **A. Quiet/monochrome (current):** chrome in fg-muted on surface, accents
  only for state, shadows minimal, hover-reveal for secondary affordances.
  "Reader-first" — the document is the star.
- **B. Softer/elevated:** more shadow, larger radii (the options page already
  leans this way with 10–12px radii and cards on a tinted page), pills and
  filled controls. "Product-like."
- **C. Dense/technical:** tighter spacing, smaller type, more visible borders,
  always-visible affordances. "IDE-like."

**Recommendation: A, stated explicitly**, with the options page pulled slightly
*toward* it in the D11 pass (its 12px radii → `--mdv-radius-lg`, its shadows →
`--mdv-shadow-1`) rather than the viewer pulled toward B. Hover-reveal stays,
with the D12.11 touch fallback.

---

## Part IV — Cross-cutting policies

### D14. The export/print mirror

`EXPORT_CSS` is a hand-kept copy of the document styles; the print palette is a
third colour block; presets don't reach exports at all. Every token change is a
multi-edit.

- **A. Keep the mirror, add a guard:** a script (in the `check-build`/`audit`
  family) that parses the token blocks from viewer.css and `EXPORT_CSS` and
  fails on divergence. Cheap, catches the drift, changes no architecture.
- **B. Generate `EXPORT_CSS`** from the D4 token source + a curated rule list.
  Removes the double edit; adds codegen (see D4 trade-offs).
- **C. Ship the exported palette as "whatever the user was using"** (embed the
  active preset's tokens into the export). Orthogonal feature decision that
  makes exports match the screen; increases the mirror's surface either way.

**Recommendation: A immediately; B only if D4-C's codegen lands anyway; C is a
product decision to park in the backlog.**

### D15. Accessibility baseline (make explicit what's implicit)

Already true: AA contrast (AAA for high-contrast preset) is test-enforced for
the document palette; focus-visible everywhere; reduced-motion strips; live
regions; real ARIA on tabs/trees/comboboxes.

Decide and write down:

- **A. Extend the contrast tests to chrome pairs** (e.g. fg-muted on surface at
  0.55 opacity — the corner pill's *effective* resting contrast is currently
  unmeasured) — or **B.** accept that idle affordances are decorative until
  hover/focus (their focused state is full-contrast) and say so.
- Minimum hit target: ratify D12.6's 1.65rem-desktop stance, or raise to 2rem.
- Keyboard reachability of hover-revealed controls: already handled (opacity,
  never display) — write it into the system as a rule: **"reveal by opacity,
  never by display/visibility."**

**Recommendation: B for idle-state contrast (with the rule that focus/hover
states must pass AA), ratify 1.65rem, codify the opacity-reveal rule.**

### D16. Process: how are decisions recorded and enforced?

- **A. A living `docs/design-system.md`** (this file evolves into the spec:
  resolved decisions move to a "Decided" section with date + rationale).
- **B. ADR-style files** (`docs/design/adr-001-spacing.md`, one per decision).
  More ceremony, better history.
- **C. Enforcement:** extend the existing script family (`check-build.mjs`,
  `audit-network.mjs` — the repo already believes in this) with a
  `check-design.mjs`: greps for banned literals (raw z-index, raw `ms`
  durations, raw disabled opacities, px font sizes in extension pages) outside
  the token files. This is how the ladder *stays* a ladder.

**Recommendation: A + C.** The repo's existing culture is exactly C-shaped;
use it. B if the project grows contributors.

---

## Part V — Known defects to fix regardless (found by the audit)

These are bugs, not decisions — fix in any order, before or during the system
work:

1. **`.msg.is-error` / `.notice.is-error` have no CSS rule** — options emits
   `is-${tone}` with tone `error`, CSS defines `.is-err`; same bug in both
   options and popup. Error messages render unstyled.
2. **`--mdv-toc-width` defined twice with different clamps** (17vw in
   viewer.css, 20vw in sidebar.css) — the top-start corner offset can
   misalign with the real sidebar edge at mid widths.
3. **Dead classes:** `.mdv-diff-where`, `.mdv-diff-picker`,
   `.mdv-export-item-label` are emitted but unstyled (verify intent, then
   style or stop emitting).
4. **Stale comments:** command-palette.css references a quick-find z-index
   that no longer exists; search-panel.css references file paths from before
   the plugin migration.
5. **`presentation.css` z-index 100 is marked temporary** and mermaid's
   fullscreen cover still uses `2147483000` — both resolved by D7's ladder.
6. **`--accent-fg` defined but unused** in options (popup uses it).
7. **sortable-tables hardcodes `120ms`** where siblings use `--mdv-dur` —
   silently decoupled from the token.

---

## Suggested resolution order

1. **Part V fixes** — no decisions needed. ⚡
2. **D1–D3** (scope, reuse, naming) — everything else depends on these three.
3. **D5–D8** (the four scales) — mechanical once named; each is
   independently shippable and immediately usable. ⚡
4. **D10** (philosophy) + **D12** (canonical picks) — the component layer.
5. **D11** (options/popup migration) + **D9** (icons).
6. **D13–D16** (register, mirror guard, a11y baseline, process) — codify.

A reasonable first milestone: Part V + D5 spacing + D7 z-index/radius + D8
opacity, applied to the viewer chrome only. Small diff, visible convergence,
zero behavior change — and it exercises the token pipeline before the bigger
calls (D4, D10, D11) are locked.
