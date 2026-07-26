# Manual testing guide

Nothing in this project has been exercised by a human beyond confirming the
extension loads. 611 automated tests cover logic against jsdom; they cannot see
layout, focus, animation, or whether a thing looks right. This guide covers what
they cannot.

Work top to bottom. Each item says **what to do** and **what should happen**.
Report anything that differs — including "looks wrong" without a reason, which
is a legitimate finding and often the only signal for a visual bug.

Test document: **`test/fixtures/manual-test.md`**. Open it beside this guide.

---

## 0. Setup

```bash
npm run build
```

Then `chrome://extensions` → Developer mode on → **Load unpacked** →
`.output/chrome-mv3`. For local files, open **Details** → enable
**Allow access to file URLs**.

Open `test/fixtures/manual-test.md` from disk.

- [ ] **0.1** The document renders instead of showing raw text.
- [ ] **0.2** No flash of raw text or of the wrong colour scheme before it paints.
- [ ] **0.3** The browser console has no errors.

If 0.1 fails, stop — everything below depends on it.

---

## 1. The shell

- [ ] **1.1** The document is centred with comfortable line length, not full-bleed.
- [ ] **1.2** Nothing scrolls sideways. The wide table scrolls *inside itself*.
- [ ] **1.2a** Nothing sits *beside* the document. Contributed chrome is either
      in a fixed corner or stacked above/below the text — never a second column.
      This regressed once: the shell was a flex row, so the export menu and the
      frontmatter card were laid out next to the article.
- [ ] **1.2b** The **Raw** button and the **Export** menu share the top-right
      corner, side by side, and neither overlaps the other or the scrollbar.
- [ ] **1.3** `r` toggles the raw view; the source appears as plain text.
- [ ] **1.4** `r` again returns to the rendered view, at the same place.
- [ ] **1.5** Print preview (⌘P) shows the document with no toolbars, sidebar,
      buttons or badges.

---

## 2. Markdown pipeline

These are nine plugins, but they read as one thing, so test them together.

- [ ] **2.1 Headings** — every heading rendered, sizes clearly distinct.
- [ ] **2.2 Emphasis** — bold, italic, strikethrough, inline code, mark, kbd,
      sub/superscript all render.
- [ ] **2.3 Emoji** — `:rocket:` etc. are pictures; `:definitely_not_an_emoji:`
      is left as literal text.
- [ ] **2.4 Footnotes** — references are superscript links; the notes are
      collected at the foot of the document with back-links.
- [ ] **2.5 Alerts** — all five (`NOTE` `TIP` `IMPORTANT` `WARNING` `CAUTION`)
      render with distinct colours and icons, readable in both themes.
- [ ] **2.6 Containers** — `:::note` / `:::tip` / `:::warning` render similarly.
- [ ] **2.7 Tables** — alignment respected (Name left, Size right).
- [ ] **2.8 Task lists** — real checkboxes, checked where written, not clickable.
- [ ] **2.9 Code** — highlighted per language; the unknown language renders as
      plain text rather than breaking.
- [ ] **2.10 Math** — inline `$e^{i\pi}+1=0$` renders as a formula; the display
      integral renders centred and larger. This is a two-stage feature: the
      parser marks the formula and the KaTeX add-on is injected to render it, so
      "the TeX is showing as its own source" means the add-on never arrived.
- [ ] **2.11 Math must not leak into code** — in the *Math* section, the code
      span, the prose dollars, and the `$ B \`c\` D $` line all stay literal.
      This one has broken before; look carefully.
- [ ] **2.12 Diagrams** — both mermaid blocks render as diagrams, not code. Same
      two-stage shape as math: a block still showing `graph TD` as source means
      the mermaid add-on was never injected.
- [ ] **2.13 Wiki links** — `[[Kitchen Sink]]` is a link whose href is
      `kitchen-sink.md` — the title is slugged, because the file a repository
      contains is kebab-case even when its title is not. `[[Guide.md]]` already
      carries an extension and is left exactly as written.
- [ ] **2.14 Inline images** — both data-URI SVGs in *Images* display. A literal
      `![...](data:image/svg+xml;base64,…)` sitting in the text as characters
      means the pipeline refused the URL rather than rendering it.

---

## 3. Frontmatter

- [ ] **3.1** A card appears above the title showing title, author, date, and
      tags as chips.
- [ ] **3.1a** The card is **in the document column** — its left and right edges
      line up with the body text, and it sits above the `# Manual Test Document`
      heading rather than beside it.
- [ ] **3.2** The `---` block itself is **not** visible as a horizontal rule or
      a stray table. Specifically: the words `every-feature` and `nested` must
      appear only in the card, never in the body. Seeing the metadata twice —
      once as a card, once as document text — means the parser was built before
      the plugins were installed.
- [ ] **3.3** The card collapses and expands.
- [ ] **3.4** Settings → Frontmatter → `display: raw` shows the block as text;
      `hidden` shows nothing. **In both cases the document below is unchanged** —
      no stray rule appears.

---

## 4. Document chrome

- [ ] **4.1 Code copy** — every code block has a copy button on hover.
- [ ] **4.2** Clicking it confirms visibly, and pasting elsewhere gives the code
      **without** the word "Copy".
- [ ] **4.3 Heading anchors** — hovering a heading reveals a link in the gutter;
      clicking copies the URL and moves the address bar.
- [ ] **4.4** The anchor does not shift the heading's text when it appears.
- [ ] **4.5 External links** — links leaving the document carry a small mark;
      in-page anchors and relative links do not.
- [ ] **4.6** The mark is *subtle* — a paragraph of links should not look
      disfigured.

---

## 5. Heading fold

- [ ] **5.1** Each heading has a fold control.
- [ ] **5.2** Folding a section hides its content up to the next heading of the
      same or shallower level.
- [ ] **5.3** Folding does **not** yank the page — the heading you clicked stays
      put.
- [ ] **5.4** Unfolding restores exactly what was there.
- [ ] **5.5** With a section folded, click an outline entry inside it — it should
      unfold and scroll there rather than jumping nowhere.
- [ ] **5.6** With a section folded, the outline highlight is still correct as
      you scroll (folded headings must not read as "already passed").
- [ ] **5.7** Print preview with a section folded shows **all** content.

---

## 6. Reading status

- [ ] **6.1** A word count and reading estimate appear.
- [ ] **6.2** The count excludes code blocks and says so.
- [ ] **6.3** A progress bar reflects position through the *document*, reaching
      full at the end.
- [ ] **6.4** It does not jitter or shift the layout while scrolling.

---

## 7. Sortable tables

Use the first table in *Tables*.

- [ ] **7.1** Headers are clickable and show a sort indicator.
- [ ] **7.2** Sorting **Size** ascending gives `-2, 9, 10, 1200` — *not*
      `-2, 10, 1200, 9`. This is the bug the feature exists to prevent.
- [ ] **7.3** The empty cell sorts to the end in **both** directions.
- [ ] **7.4** **Released** sorts as dates, not strings.
- [ ] **7.5** A third click restores the **original** document order.
- [ ] **7.6** Keyboard: Tab to a header, Enter sorts.
- [ ] **7.7** The spanning table has **no** sort affordance at all.
- [ ] **7.8** Sort a table, then export to HTML (§12). The exported file must be
      in **document order**, not your sort.

---

## 8. Broken links

Off by default — enable it in Settings first.

- [ ] **8.1** `#no-such-heading-anywhere` is marked as broken.
- [ ] **8.2** `#headings-and-the-outline` and `#options-1` are **not** marked.
- [ ] **8.3** `https://example.com` is **never** marked, and the network tab
      shows no request to it.
- [ ] **8.4** `mailto:` is not marked.
- [ ] **8.5** A count appears in the bottom-left; clicking lists the broken links
      and picking one scrolls to it.
- [ ] **8.6** With no folder open, relative links are **not** marked (unknown is
      not the same as missing).

---

## 9. Hover previews

- [ ] **9.1** Hovering a footnote reference shows its text after a short pause.
- [ ] **9.2** The pause is noticeable — skimming the document should not spray
      popups.
- [ ] **9.3** Hovering an in-page anchor previews that section.
- [ ] **9.4** The preview fades out at the bottom when content is cut off.
- [ ] **9.5** Near the bottom or right edge it flips or shifts rather than
      clipping.
- [ ] **9.6** Hovering an **external** link shows nothing, and makes no request.
- [ ] **9.7** Escape dismisses; focus never moves into the preview.

---

## 10. Sidebar: Outline, Files, Search

- [ ] **10.1** The sidebar shows tabs: Outline, Files, Search.
- [ ] **10.2** Outline lists headings, indented by level.
- [ ] **10.3** The entry for the section you are reading highlights as you
      scroll, and stays correct scrolling *up*.
- [ ] **10.4** Clicking an entry scrolls there and updates the address bar.
- [ ] **10.5** `t` hides and shows the sidebar.
- [ ] **10.6** Collapsed, the document reflows to use the space.
- [ ] **10.7** **Files** → open a folder → the markdown files appear as a tree.
- [ ] **10.8** `node_modules`, `.git` and dotfiles are absent.
- [ ] **10.9** Clicking a file opens it; the current file is marked.
- [ ] **10.10** Reload the page — the folder is remembered, or offers to
      reconnect. It must not silently appear empty.

---

## 11. Search

- [ ] **11.1** `Ctrl/⌘+F` opens the find bar instead of Chrome's.
- [ ] **11.2** Typing `document` highlights all matches and shows a count.
- [ ] **11.3** Enter / Shift+Enter step forward and back, scrolling each into
      view, with the current match distinct from the rest.
- [ ] **11.4** **The document behind stays clickable and selectable** while the
      bar is open. (It was modal by mistake; this is the check.)
- [ ] **11.5** Matches inside code blocks are highlighted without corrupting the
      syntax colouring.
- [ ] **11.6** Escape closes and returns focus where it was.
- [ ] **11.7** `Ctrl/⌘+Shift+F` opens the Search *tab* listing every match with a
      heading breadcrumb and line number.
- [ ] **11.8** Clicking a result scrolls to it and highlights it.
- [ ] **11.9** Arrow keys move through results; Enter jumps; Escape restores the
      previously active tab.
- [ ] **11.10** The `.*` regex toggle works, and an invalid pattern shows an
      inline error rather than freezing.
- [ ] **11.11** A catastrophic pattern — try `(a+)+$` — does **not** hang the
      tab.

---

## 12. Export

- [ ] **12.1** An export control is present.
- [ ] **12.2** Export to **HTML** downloads a file.
- [ ] **12.3** Opening it **offline, outside the extension** shows the document
      styled, with images, and no viewer chrome — no sidebar, no buttons, no
      copy affordances.
- [ ] **12.4** Export to **Word** downloads a `.docx` that opens.
- [ ] **12.5** Word's navigation pane shows the headings.
- [ ] **12.6** Tables, lists and code survive; diagrams degrade to a marker
      rather than vanishing silently.
- [ ] **12.7** Export reports honestly if images could not be embedded.

---

## 13. Lightbox

- [ ] **13.1** Clicking an image opens it larger.
- [ ] **13.2** Arrows move between the two images; a counter shows position.
- [ ] **13.3** `+` / `-` / `0` zoom and reset; dragging pans when zoomed.
- [ ] **13.4** Scrolling the page behind is **blocked** while it is open.
- [ ] **13.5** Escape closes and focus returns to the image you opened.
- [ ] **13.6** Tab cycles **inside** the lightbox and never reaches the document.
- [ ] **13.7** The **linked** image follows its link rather than opening.
- [ ] **13.8** The broken image shows a clear state, not an empty box.

---

## 14. Presentation

- [ ] **14.1** A presentation control is present.
- [ ] **14.2** Starting it fills the screen with one slide.
- [ ] **14.3** Text is large enough to read across a room.
- [ ] **14.4** Arrows / space / PageUp / PageDown move between slides; a counter
      shows position.
- [ ] **14.5** Code blocks and tables fit the slide or scroll within it — nothing
      runs off-screen.
- [ ] **14.6** Escape exits and returns you where you were.
- [ ] **14.7** While presenting, `t` and `r` do **not** toggle the sidebar or the
      raw view behind the deck.

---

## 15. Diff

- [ ] **15.1** With a folder open, right-clicking a file offers "Compare with
      current file".
- [ ] **15.2** The comparison opens split-source by default, both filenames in
      the header.
- [ ] **15.3** Changed lines are marked; next/previous change navigation works.
- [ ] **15.4** Swapping sides works.
- [ ] **15.5** The rendered-diff mode shows both documents side by side.
- [ ] **15.6** It is read-only — nothing is editable.
- [ ] **15.7** The keyboard menu route works, not only right-click.

---

## 16. Command palette

- [ ] **16.1** `Ctrl/⌘+K` opens it.
- [ ] **16.2** Typing filters across headings, files, settings and commands, and
      each row shows which kind it is.
- [ ] **16.3** Arrows move, Enter runs, Escape closes and restores focus.
- [ ] **16.4** "Toggle theme" changes the theme.
- [ ] **16.5** "Export as HTML" appears and works.
- [ ] **16.6** **Disable the export plugin in settings**, reopen the palette —
      the export rows are **gone**, not present-but-broken.
- [ ] **16.7** With no folder open, "Compare files" is absent.

---

## 17. Theme and typography

- [ ] **17.1** `d` cycles the theme; the document repaints without reloading.
- [ ] **17.2** Auto follows the system setting.
- [ ] **17.3** Every preset is readable — check code blocks and alerts, which are
      where contrast usually fails.
- [ ] **17.4** Font family / size / line height / width all change the document
      live.
- [ ] **17.5** Custom CSS applies. Try `.mdv-body { letter-spacing: .02em }`.
- [ ] **17.6** Custom CSS containing `url(https://…)` is rejected with an
      explanation rather than silently dropped.
- [ ] **17.7** Reload — every choice persists.

---

## 18. Scroll memory and live reload

- [ ] **18.1** Scroll halfway, navigate away, come back — you return near where
      you were.
- [ ] **18.2** Change the font size and reopen — the position is still about
      right (it is anchored to headings, not pixels).
- [ ] **18.3** Enable **live reload** in settings. Edit the file on disk and save
      — the document updates without a manual reload.
- [ ] **18.4** Your scroll position is not lost when it updates.
- [ ] **18.5** Disable live reload. Edit and save — **nothing happens**, and the
      network tab shows no further requests.

---

## 19. The settings page

- [ ] **19.1** Two columns: contents on the left, settings on the right.
- [ ] **19.2** Contents reads **General** (Rendering, Local files, Sites, Pinned
      documents, Backup) then **Plugins**, grouped.
- [ ] **19.3** Clicking an entry scrolls to that section.
- [ ] **19.4** The entry for the section you are viewing highlights as you
      scroll. *(Unverified — this is the one I could not test.)*
- [ ] **19.5** The filter narrows the contents list.
- [ ] **19.6** Theme settings are inside the **Theme** plugin's card, typography
      inside **Typography**. There is no separate "General" settings card.
- [ ] **19.7** Narrow the window — it collapses to one column, contents on top.
- [ ] **19.8** Backup: export settings to JSON, change something, import it back.
- [ ] **19.9** Import a deliberately corrupt JSON file — it reports the problem
      and changes nothing.

---

## 20. The plugin architecture itself

**This is the most important section.** Every claim the refactor rests on is
here, and all of it is verified only against a synthetic DOM so far.

For each plugin below: **disable it in settings with the document open**, and
check the feature disappears *immediately* with no reload, leaving nothing
behind — no stray button, no marker, no gap, no console error. Then re-enable it
and check it comes back correctly.

- [ ] **20.1** `code-copy` — buttons vanish; code blocks look untouched.
- [ ] **20.2** `heading-anchors` — gutter links gone; headings unmoved.
- [ ] **20.3** `external-links` — marks gone from every link.
- [ ] **20.4** `heading-fold` — controls gone; **any folded section is expanded**.
- [ ] **20.5** `reading-status` — count and progress bar gone.
- [ ] **20.6** `sortable-tables` — affordance gone and **rows back in document
      order**, even if you had sorted them.
- [ ] **20.7** `lightbox` — images no longer open; cursor no longer suggests it.
- [ ] **20.8** `sidebar` — the whole column goes, document reflows, **and the
      Outline/Files/Search tabs go with it without erroring**.
- [ ] **20.9** `outline` — that tab alone goes; Files and Search remain.
- [ ] **20.10** `quick-find` — `Ctrl+F` returns to Chrome's own find bar.
- [ ] **20.11** `command-palette` — `Ctrl+K` does nothing.
- [ ] **20.12** `presentation` — the control goes; if a deck was open it closes.
- [ ] **20.13** `markdown-math` — formulae render as literal `$…$` text.
- [ ] **20.14** `markdown-mermaid-fence` — diagrams render as code blocks.
- [ ] **20.15** `markdown-github-alerts` — alerts render as plain blockquotes.
- [ ] **20.16** `markdown-emoji` — `:rocket:` stays literal.
- [ ] **20.17** `frontmatter` — the card goes **and the block renders as ordinary
      markdown**, not vanishing.
- [ ] **20.18** `theme` — the document keeps its current colours; changing the
      theme setting no longer repaints live (reload still applies it).
- [ ] **20.19** `typography` — font settings stop applying live.

Then:

- [ ] **20.20** Toggle one plugin off and on **five times** with the document
      open. No duplicated buttons, no accumulating markers, no console errors.
      *(This is the residue failure the whole teardown contract exists for.)*
- [ ] **20.21** Disable **every** plugin. The document should still render as
      plain sanitized markdown, with no errors.
- [ ] **20.22** Re-enable them all. Everything returns.

---

## 21. Security

- [ ] **21.1** In *Sanitization*, no dialog appears and the page does not blank.
- [ ] **21.2** Console has no errors from that section.
- [ ] **21.3** DevTools → Elements: no `<script>`, `<iframe>`, `<form>` or
      `<style>` inside the rendered body, and no `on*` attributes.
- [ ] **21.4** The `javascript:` link does nothing when clicked.
- [ ] **21.5** DevTools → Network, reload with everything enabled and live reload
      **off**: **no requests at all** beyond the document itself.
- [ ] **21.6** `chrome://extensions` → Details: permissions are storage,
      activeTab, scripting, downloads. **No host permissions** unless you granted
      one.

---

## 22. Known gaps

Not bugs — things already known, listed so you do not spend time on them.

- **Scroll lock during export**: sorting a table then exporting briefly shows
  rows in document order while the export runs. Deliberate — the alternative is
  an exported file frozen in a view you can no longer undo.
- **`file://` and tier-2 broken links**: relative-file checking only works for
  documents opened *through* the Files tab, not for a `file://` address opened
  directly. The folder browser knows the base internally but does not publish it.
- **Hover previews across files** need a folder open; otherwise they skip
  silently.
- **Live reload on `file://`** gives up after one failure rather than retrying.
- **Settings-page scroll-spy** (19.4) is the one thing never exercised, in any
  form.
- **No settings migration**: the plugin refactor changed how settings are stored,
  so anything configured before it is back at defaults. Expected.
