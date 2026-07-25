/**
 * The pure half of the export pipeline: filename derivation, the HTML document
 * assembly, and the DOM → Word structural mapping.
 *
 * jsdom rather than a lighter DOM shim, for the same reason `markdown.test.ts`
 * gives: `lib/export.ts` reaches `lib/markdown.ts` for `escapeHtml`, and
 * DOMPurify binds to whatever `window` exists when that module is first
 * imported. Under a shim it decides it is unsupported and passes its input
 * through untouched — so the fixtures below, which are markdown output round
 * tripped through the real pipeline, would silently stop being sanitized and
 * every claim made about the exported HTML would be made about the wrong string.
 *
 * Everything here runs against a document built with jsdom's parser, because
 * the planner walks real nodes and the whitespace between tags is part of what
 * it has to cope with.
 */
import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { JSDOM } from 'jsdom';

type ExportModule = typeof import('../lib/export.ts');

let mod: ExportModule;
let dom: JSDOM;

/** Parses a fragment of rendered document HTML into a `.mdv-body`-alike root. */
function body(html: string): Element {
  const root = dom.window.document.createElement('main');
  root.className = 'mdv-body';
  root.innerHTML = html;
  return root;
}

/** A 1x1 transparent PNG — the smallest thing that is a real image. */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
  'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  dom = new JSDOM('', { url: 'https://example.test/docs/readme.md' });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    'window',
    'document',
    'Node',
    'DocumentFragment',
    'HTMLTemplateElement',
    'NodeFilter',
    'trustedTypes',
  ]) {
    globals[name] =
      name === 'window'
        ? dom.window
        : (dom.window as unknown as Record<string, unknown>)[name];
  }

  mod = await import('../lib/export.ts');
});

/* -------------------------------------------------------------------------- */
/* Filenames                                                                   */
/* -------------------------------------------------------------------------- */

test('a hostile heading cannot produce a path', () => {
  // The document names the file, and the document is untrusted. Nothing that
  // comes out of here may be read as a directory by a download API.
  for (const hostile of [
    '../../etc/passwd',
    '..\\..\\Windows\\System32',
    '/absolute/path',
    './../sneaky',
    '....//....//etc',
  ]) {
    const name = mod.sanitizeFilename(hostile);
    assert.ok(!name.includes('/'), `${hostile} kept a forward slash: ${name}`);
    assert.ok(!name.includes('\\'), `${hostile} kept a backslash: ${name}`);
    assert.ok(!name.includes('..'), `${hostile} kept a parent segment: ${name}`);
    assert.ok(!name.startsWith('.'), `${hostile} became a dotfile: ${name}`);
    assert.ok(!name.startsWith('-'), `${hostile} became option-like: ${name}`);
  }
});

test('control characters are removed, not replaced', () => {
  // A NUL truncates the name in some APIs and a newline hides the rest of it in
  // the download shelf, so both are a way to make a file claim to be something
  // it is not. Neither may survive in any form.
  const name = mod.sanitizeFilename('report\u0000.sh\u000areally-a-script');
  assert.equal(name, 'report.shreally-a-script');
});

test('an absurdly long heading is clamped to something a filesystem takes', () => {
  const name = mod.sanitizeFilename('x'.repeat(5000));
  assert.ok(name.length <= 100, `still ${name.length} characters`);
  assert.equal(name, 'x'.repeat(100));
});

test('a heading that sanitizes away still names a file', () => {
  for (const empty of ['', '...', '///', '   ', '\u0000\u0007']) {
    assert.equal(mod.sanitizeFilename(empty), 'document');
  }
});

test('windows device names are defused', () => {
  // `CON.html` is still the console device on Windows; the extension does not
  // make it a file.
  assert.equal(mod.sanitizeFilename('CON'), 'CON-file');
  assert.equal(mod.sanitizeFilename('com1'), 'com1-file');
  assert.equal(mod.sanitizeFilename('console'), 'console');
});

test('ordinary headings survive readably', () => {
  assert.equal(mod.sanitizeFilename('Getting Started'), 'Getting-Started');
  assert.equal(mod.sanitizeFilename('Install & Setup'), 'Install-&-Setup');
  assert.equal(mod.sanitizeFilename('日本語のタイトル'), '日本語のタイトル');
});

test('the extension comes from EXPORT_FORMATS', () => {
  assert.equal(mod.exportFilename('My Doc', 'html'), 'My-Doc.html');
  assert.equal(mod.exportFilename('My Doc', 'docx'), 'My-Doc.docx');
  assert.equal(mod.exportFilename('../../etc/passwd', 'docx'), 'etcpasswd.docx');
});

test('the title falls back from heading to url to a constant', () => {
  assert.equal(mod.documentTitle(body('<h1>Real Title</h1>'), 'https://a.test/x.md'), 'Real Title');
  assert.equal(mod.documentTitle(body('<p>no heading</p>'), 'https://a.test/guide.md'), 'guide');
  // A percent-encoded name is what the reader sees decoded in the tab.
  assert.equal(mod.documentTitle(body(''), 'https://a.test/My%20Notes.markdown'), 'My Notes');
  assert.equal(mod.documentTitle(body(''), 'not a url'), 'document');
});

/* -------------------------------------------------------------------------- */
/* Cleaning                                                                    */
/* -------------------------------------------------------------------------- */

test('viewer chrome does not reach the export', () => {
  const clean = mod.cleanForExport(
    body(
      [
        '<div class="mdv-toolbar" data-mdv-chrome><button>Raw</button></div>',
        '<h2 id="s">Section<a class="mdv-anchor" href="#s"><svg></svg></a></h2>',
        '<div class="mdv-code"><button class="mdv-copy">Copy</button><pre><code>x</code></pre></div>',
      ].join(''),
    ),
  );

  const html = clean.innerHTML;
  assert.ok(!html.includes('mdv-toolbar'));
  assert.ok(!html.includes('mdv-anchor'));
  assert.ok(!html.includes('mdv-copy'));
  assert.ok(!html.includes('<button'));
  // The code block itself has to survive its wrapper being removed.
  assert.ok(html.includes('<pre><code>x</code></pre>'));
  assert.ok(!html.includes('mdv-code'));
});

test('links are absolutised except in-page anchors', () => {
  const clean = mod.cleanForExport(
    body('<a href="guide.md">rel</a><a href="#top">frag</a><a href="https://x.test/">abs</a>'),
    { baseUrl: 'https://example.test/docs/readme.md' },
  );

  const hrefs = [...clean.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  // The fragment stays relative or every outline link in the export would
  // navigate back to the original document instead of scrolling.
  assert.deepEqual(hrefs, ['https://example.test/docs/guide.md', '#top', 'https://x.test/']);
});

test('snapshots are applied in document order and misses keep a usable src', () => {
  const clean = mod.cleanForExport(
    body('<img src="a.png" alt="a"><img src="b.png" alt="b">'),
    {
      baseUrl: 'https://example.test/docs/readme.md',
      // The second image is the cross-origin one whose canvas was tainted.
      images: [{ dataUrl: PNG_1X1, mime: 'image/png', width: 1, height: 1 }, null],
    },
  );

  const images = [...clean.querySelectorAll('img')];
  assert.equal(images[0].getAttribute('src'), PNG_1X1);
  assert.equal(images[0].getAttribute('width'), '1');
  // Absolutised rather than left relative: the export is about to be opened
  // from a different directory, where `b.png` resolves to nothing.
  assert.equal(images[1].getAttribute('src'), 'https://example.test/docs/b.png');
});

test('katex is reduced to the MathML browsers render without katex.css', () => {
  const clean = mod.cleanForExport(
    body(
      '<span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span>' +
        '<span class="katex-html" aria-hidden="true">SPANSOUP</span></span>',
    ),
  );

  assert.ok(clean.innerHTML.includes('<math'));
  assert.ok(!clean.innerHTML.includes('SPANSOUP'));
  assert.ok(!clean.innerHTML.includes('katex'));
});

/* -------------------------------------------------------------------------- */
/* HTML assembly                                                               */
/* -------------------------------------------------------------------------- */

test('the exported html is self-contained', () => {
  const html = mod.buildHtmlDocument({ title: 'T', bodyHtml: '<p>hi</p>', theme: 'dark' });

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  // The whole zero-network guarantee, restated as one assertion: no stylesheet
  // link, no script, no remote url() anywhere in the file.
  assert.ok(!/<link\b/i.test(html), 'the export links an external resource');
  assert.ok(!/<script\b/i.test(html), 'the export carries a script');
  assert.ok(!/url\(\s*['"]?https?:/i.test(html), 'the export references a remote resource');
  assert.ok(!/@(?:import|font-face)/i.test(html), 'the export pulls in a font or sheet');
  assert.ok(html.includes('<style>'), 'the document css was not inlined');
  assert.ok(html.includes('.mdv-body'), 'the document rules are missing');
  assert.ok(html.includes('@media print'), 'the export is not printable');
});

test('the reader’s theme is what the export opens in', () => {
  assert.ok(mod.buildHtmlDocument({ title: 'T', bodyHtml: '', theme: 'dark' })
    .includes('data-mdv-theme="dark"'));
  assert.ok(mod.buildHtmlDocument({ title: 'T', bodyHtml: '', theme: 'light' })
    .includes('data-mdv-theme="light"'));
  // Anything else is not a theme; it must not reach the attribute.
  assert.ok(mod.buildHtmlDocument({ title: 'T', bodyHtml: '', theme: '" onload="x' })
    .includes('data-mdv-theme="light"'));
});

test('a hostile title cannot break out of the title element', () => {
  // The title comes from the document's first heading, so it is attacker
  // controlled even though the body around it is already sanitized.
  const html = mod.buildHtmlDocument({
    title: '</title><script>alert(1)</script>',
    bodyHtml: '<p>ok</p>',
  });

  assert.ok(!/<script/i.test(html), 'a script escaped through the title');
  assert.ok(html.includes('&lt;/title&gt;'));
});

test('typography is looked up, never interpolated', () => {
  const html = mod.buildHtmlDocument({
    title: 'T',
    bodyHtml: '',
    typography: {
      fontFamily: 'serif',
      contentWidth: 'wide',
      fontSize: 19,
      lineHeight: 1.8,
    },
  });

  assert.ok(html.includes('--mdv-font-size: 19px'));
  assert.ok(html.includes('--mdv-line-height: 1.8'));
  assert.ok(html.includes('--mdv-measure: 90ch'));
  assert.ok(html.includes('Iowan Old Style'), 'the serif stack was not applied');

  // A number out of range is clamped rather than trusted, and a value that is
  // not a number at all is dropped instead of ending up in the stylesheet.
  const hostile = mod.buildHtmlDocument({
    title: 'T',
    bodyHtml: '',
    typography: {
      fontSize: 1e6,
      lineHeight: '2; } body { display: none } :root {' as unknown as number,
    },
  });
  assert.ok(hostile.includes('--mdv-font-size: 72px'));
  assert.ok(!hostile.includes('display: none'));
});

/* -------------------------------------------------------------------------- */
/* DOCX structural mapping                                                     */
/* -------------------------------------------------------------------------- */

test('headings keep their level so Word can build a navigation pane', () => {
  const blocks = mod.planDocument(body('<h1>One</h1><h3>Three</h3><h6>Six</h6>'));

  assert.deepEqual(
    blocks.map((b) => [b.kind, b.kind === 'heading' ? b.level : null]),
    [['heading', 1], ['heading', 3], ['heading', 6]],
  );
});

test('inline formatting maps run by run', () => {
  const [block] = mod.planDocument(
    body('<p>plain <strong>bold</strong> <em>it</em> <del>gone</del> <code>x</code> <mark>hi</mark></p>'),
  );

  assert.equal(block.kind, 'paragraph');
  assert.deepEqual(
    block.kind === 'paragraph'
      ? block.runs.map((r) => [r.text, r.bold, r.italics, r.strike, r.code, r.highlight])
      : [],
    [
      ['plain ', undefined, undefined, undefined, undefined, undefined],
      ['bold', true, undefined, undefined, undefined, undefined],
      [' ', undefined, undefined, undefined, undefined, undefined],
      ['it', undefined, true, undefined, undefined, undefined],
      [' ', undefined, undefined, undefined, undefined, undefined],
      ['gone', undefined, undefined, true, undefined, undefined],
      [' ', undefined, undefined, undefined, undefined, undefined],
      ['x', undefined, undefined, undefined, true, undefined],
      [' ', undefined, undefined, undefined, undefined, undefined],
      ['hi', undefined, undefined, undefined, undefined, true],
    ],
  );
});

test('nested formatting composes rather than replacing', () => {
  const [block] = mod.planDocument(body('<p><strong>a<em>b</em></strong></p>'));
  const runs = block.kind === 'paragraph' ? block.runs : [];

  assert.deepEqual(runs.map((r) => [r.text, r.bold, r.italics]), [
    ['a', true, undefined],
    ['b', true, true],
  ]);
});

test('links carry their target, but in-page fragments become plain text', () => {
  const blocks = mod.planDocument(
    body('<p><a href="https://x.test/">out</a> and <a href="#s">in</a></p>'),
  );
  const runs = blocks[0].kind === 'paragraph' ? blocks[0].runs : [];

  assert.equal(runs.find((r) => r.text === 'out')?.link, 'https://x.test/');
  // `#s` points into a page that no longer exists once this is a .docx, so the
  // text survives and the dead link does not.
  assert.equal(runs.find((r) => r.text === 'in')?.link, undefined);
});

test('lists nest, and each ordered list restarts its numbering', () => {
  const blocks = mod.planDocument(
    body(
      [
        '<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>',
        '<ol><li>one</li></ol>',
        '<ol><li>also one</li></ol>',
      ].join(''),
    ),
  );

  assert.deepEqual(
    blocks.map((b) =>
      b.kind === 'list-item' ? [b.runs[0]?.text, b.ordered, b.level, b.instance] : [b.kind],
    ),
    [
      ['a', false, 0, 0],
      ['a1', false, 1, 0],
      ['b', false, 0, 0],
      ['one', true, 0, 0],
      // A second ordered list gets its own numbering instance, or Word would
      // continue it from the first and render "2.".
      ['also one', true, 0, 1],
    ],
  );
});

test('a loose list keeps its first paragraph on the item itself', () => {
  // GFM wraps loose-list content in <p>. Treating that paragraph as a block
  // under the item would leave every bullet blank.
  const blocks = mod.planDocument(
    body('<ul><li><p>first</p><p>second</p></li></ul>'),
  );

  assert.equal(blocks[0].kind, 'list-item');
  assert.equal(blocks[0].kind === 'list-item' ? blocks[0].runs[0].text : '', 'first');
  assert.equal(blocks[1].kind, 'paragraph');
  assert.equal(blocks[1].kind === 'paragraph' ? blocks[1].runs[0].text : '', 'second');
});

test('task list checkboxes degrade to characters', () => {
  const blocks = mod.planDocument(
    body('<ul><li><input type="checkbox" checked disabled> done</li><li><input type="checkbox" disabled> todo</li></ul>'),
  );

  const texts = blocks.map((b) => (b.kind === 'list-item' ? b.runs.map((r) => r.text).join('') : ''));
  assert.deepEqual(texts, ['☒ done', '☐ todo']);
});

test('code blocks become one line per paragraph', () => {
  // A Word paragraph cannot hold a newline, so the split has to happen here.
  const blocks = mod.planDocument(
    body('<pre><code class="hljs language-js"><span class="hljs-keyword">const</span> x = 1;\nconst y = 2;\n</code></pre>'),
  );

  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].kind === 'code' ? blocks[0].lines : [], [
    'const x = 1;',
    'const y = 2;',
  ]);
});

test('blockquotes mark their paragraphs, including nested ones', () => {
  const blocks = mod.planDocument(
    body('<blockquote><p>quoted</p><blockquote><p>deeper</p></blockquote></blockquote><p>after</p>'),
  );

  assert.deepEqual(
    blocks.map((b) => (b.kind === 'paragraph' ? [b.runs[0].text, b.style] : [b.kind])),
    [['quoted', 'quote'], ['deeper', 'quote'], ['after', undefined]],
  );
});

test('tables keep their header flag and column alignment', () => {
  const blocks = mod.planDocument(
    body(
      '<table><thead><tr><th align="right">H</th></tr></thead>' +
        '<tbody><tr><td align="right">1</td></tr></tbody></table>',
    ),
  );

  assert.equal(blocks.length, 1);
  const rows = blocks[0].kind === 'table' ? blocks[0].rows : [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells[0].header, true);
  assert.equal(rows[0].cells[0].align, 'right');
  assert.equal(rows[1].cells[0].header, false);
  // Cells are planned as containers, so block content inside one survives.
  assert.equal(rows[1].cells[0].blocks[0].kind, 'paragraph');
});

test('horizontal rules survive as their own block', () => {
  const blocks = mod.planDocument(body('<p>a</p><hr><p>b</p>'));
  assert.deepEqual(blocks.map((b) => b.kind), ['paragraph', 'rule', 'paragraph']);
});

test('what Word cannot draw degrades to readable text, never to nothing', () => {
  const blocks = mod.planDocument(
    body(
      [
        '<p><svg viewBox="0 0 1 1"></svg></p>',
        '<p><math><semantics><mi>x</mi><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></p>',
        '<p><img src="https://x.test/photo.png" alt="A photo"></p>',
        '<figure><figcaption>caption</figcaption></figure>',
        '<dl><dt>Term</dt><dd>Definition</dd></dl>',
        '<details><summary>More</summary><p>hidden</p></details>',
      ].join(''),
    ),
  );

  const texts = blocks.map((b) =>
    b.kind === 'paragraph' ? b.runs.map((r) => r.text).join('') : b.kind,
  );

  // A mermaid diagram and a formula both leave a mark on the page rather than a
  // silent hole; an image that was never embedded falls back to its alt text.
  assert.deepEqual(texts, [
    '[diagram]',
    'E = mc^2',
    'A photo',
    'caption',
    'Term',
    'Definition',
    'More',
    'hidden',
  ]);
  assert.equal(blocks[3].kind === 'paragraph' ? blocks[3].style : '', 'caption');
});

test('an embedded image is planned as an image run, not as its alt text alone', () => {
  const clean = mod.cleanForExport(body('<p><img src="a.png" alt="chart"></p>'), {
    baseUrl: 'https://example.test/',
    images: [{ dataUrl: PNG_1X1, mime: 'image/png', width: 1, height: 1 }],
  });
  const [block] = mod.planDocument(clean);
  const run = block.kind === 'paragraph' ? block.runs[0] : undefined;

  assert.equal(run?.image?.mime, 'image/png');
  // The alt text rides along so the builder still has something to write if the
  // format turns out not to be one the package can hold.
  assert.equal(run?.text, 'chart');
});

test('the whitespace between tags does not become text in Word', () => {
  // Rendered HTML is indented. A browser collapses it; Word would not.
  const blocks = mod.planDocument(body('<p>\n  one\n  <em>two</em>\n</p>'));
  const runs = blocks[0].kind === 'paragraph' ? blocks[0].runs : [];

  assert.deepEqual(runs.map((r) => r.text), ['one ', 'two']);
});

test('unknown containers recurse instead of dropping their contents', () => {
  const blocks = mod.planDocument(body('<section><aside>kept</aside></section>'));
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'paragraph' ? b.runs[0].text : b.kind)),
    ['kept'],
  );
});

/* -------------------------------------------------------------------------- */
/* DOCX package                                                                */
/* -------------------------------------------------------------------------- */

test('the plan builds into a real docx package', async () => {
  const { Packer } = await import('docx');
  const clean = mod.cleanForExport(
    body(
      [
        '<h1>Title</h1><p>Body with <strong>bold</strong> and <a href="https://x.test/">a link</a>.</p>',
        '<ol><li>one<ul><li>nested</li></ul></li></ol>',
        '<pre><code>const x = 1;</code></pre>',
        '<blockquote><p>quoted</p></blockquote><hr>',
        '<table><tr><th>H</th></tr><tr><td>1</td></tr></table>',
        '<p><img src="a.png" alt="pic"></p>',
      ].join(''),
    ),
    {
      baseUrl: 'https://example.test/',
      images: [{ dataUrl: PNG_1X1, mime: 'image/png', width: 1, height: 1 }],
    },
  );

  const { document, skippedImages } = mod.buildDocxDocument(mod.planDocument(clean), {
    title: 'Title',
  });

  assert.equal(skippedImages, 0, 'the png should have been embedded');

  const buffer = await Packer.toBuffer(document);
  // "PK" — the zip magic every OOXML package starts with.
  assert.equal(String.fromCharCode(buffer[0], buffer[1]), 'PK');
  assert.ok(buffer.length > 1000);
});

test('an image in a format the package cannot hold is counted, not dropped', async () => {
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
  const clean = mod.cleanForExport(body('<p><img src="d.svg" alt="a diagram"></p>'), {
    images: [{ dataUrl: svg, mime: 'image/svg+xml', width: 10, height: 10 }],
  });

  const { document, skippedImages } = mod.buildDocxDocument(mod.planDocument(clean), {
    title: 'T',
  });

  assert.equal(skippedImages, 1);
  // Still a valid document — the alt text went in where the image would have.
  const { Packer } = await import('docx');
  assert.ok((await Packer.toBuffer(document)).length > 0);
});
