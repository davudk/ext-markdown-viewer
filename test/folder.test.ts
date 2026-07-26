/**
 * Folder browser plumbing.
 *
 * Directory handles are faked with plain objects: `readDirectory` and
 * `resolveFileUrlBase` only ever call `values()`, `getDirectoryHandle`,
 * `getFileHandle` and `getFile().text()`, and what is worth testing is the
 * decisions they make from those — what gets filtered out, what order it comes
 * back in, and above all whether a guessed `file://` base is accepted.
 *
 * That last one is the failure mode that matters. Accepting the wrong base
 * silently turns every row in the tree into a link to somebody else's file, and
 * nothing on screen would say so.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SUPPORTED_PROTOCOLS } from '../lib/config.ts';
import {
  FOLDER_ENTRY_LIMIT,
  fileUrlBaseCandidates,
  fileUrlFor,
  folderDocumentPath,
  folderDocumentUrl,
  isMarkdownName,
  isSkippedName,
  joinPath,
  normalizeSource,
  readDirectory,
  relativePathFrom,
  resolveFileUrlBase,
  sortEntries,
} from '../lib/folder.ts';
import { documentKey } from '../lib/document-state.ts';

/* -------------------------------------------------------------------------- */
/* Fake handles                                                                */
/* -------------------------------------------------------------------------- */

interface Tree {
  [name: string]: Tree | string;
}

/** A directory handle over a plain nested object. Files are their contents. */
function directory(name: string, tree: Tree): FileSystemDirectoryHandle {
  const handle = {
    kind: 'directory' as const,
    name,
    async *values() {
      for (const [child, value] of Object.entries(tree)) {
        yield typeof value === 'string' ? file(child, value) : directory(child, value);
      }
    },
    async getDirectoryHandle(child: string) {
      const value = tree[child];
      if (typeof value !== 'object') throw new Error('NotFoundError');
      return directory(child, value);
    },
    async getFileHandle(child: string) {
      const value = tree[child];
      if (typeof value !== 'string') throw new Error('NotFoundError');
      return file(child, value);
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

function file(name: string, text: string): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name,
    async getFile() {
      return { async text() { return text; } };
    },
  } as unknown as FileSystemFileHandle;
}

/* -------------------------------------------------------------------------- */
/* Names                                                                       */
/* -------------------------------------------------------------------------- */

test('every configured markdown extension is recognised, case-insensitively', () => {
  for (const name of ['a.md', 'a.markdown', 'a.mkd', 'a.mdx', 'A.MD', 'notes.MarkDown']) {
    assert.equal(isMarkdownName(name), true, name);
  }

  for (const name of ['README', 'a.txt', 'a.md.bak', 'md', '.md.swp']) {
    assert.equal(isMarkdownName(name), false, name);
  }
});

test('dotted names and the two big non-dotted directories are skipped', () => {
  for (const name of ['.git', '.DS_Store', '.obsidian', 'node_modules']) {
    assert.equal(isSkippedName(name), true, name);
  }

  for (const name of ['docs', 'README.md', 'my.notes']) {
    assert.equal(isSkippedName(name), false, name);
  }
});

test('directories sort before files, each group naturally', () => {
  const sorted = sortEntries([
    { name: 'b.md', kind: 'file' as const },
    { name: 'chapter10.md', kind: 'file' as const },
    { name: 'zeta', kind: 'directory' as const },
    { name: 'chapter2.md', kind: 'file' as const },
    { name: 'alpha', kind: 'directory' as const },
  ]);

  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ['alpha', 'zeta', 'b.md', 'chapter2.md', 'chapter10.md'],
  );
});

test('joinPath leaves the root path empty rather than leading with a slash', () => {
  assert.equal(joinPath('', 'docs'), 'docs');
  assert.equal(joinPath('docs', 'a.md'), 'docs/a.md');
});

test('normalizeSource matches what the HTML parser does to a plain-text file', () => {
  assert.equal(normalizeSource('﻿a\r\nb\rc'), 'a\nb\nc');
});

/* -------------------------------------------------------------------------- */
/* Document identity                                                           */
/* -------------------------------------------------------------------------- */

test('a handle-read document gets an identity nothing will try to fetch', () => {
  const url = folderDocumentUrl('my notes', 'sub dir/a.md');

  // The point of the scheme: live reload only polls SUPPORTED_PROTOCOLS, so it
  // declines this without needing to know the folder browser exists.
  assert.equal(SUPPORTED_PROTOCOLS.includes(new URL(url).protocol), false);

  // And scroll memory still keys on it, one entry per file.
  assert.notEqual(
    documentKey(folderDocumentUrl('notes', 'a.md')),
    documentKey(folderDocumentUrl('notes', 'b.md')),
  );
  assert.equal(
    documentKey(`${folderDocumentUrl('notes', 'a.md')}#section`),
    documentKey(folderDocumentUrl('notes', 'a.md')),
  );
});

test('an identity round-trips back to the path inside its own root', () => {
  const url = folderDocumentUrl('my notes', 'sub dir/a b.md');
  assert.equal(folderDocumentPath(url, 'my notes'), 'sub dir/a b.md');

  // A different folder with the same file in it is not the same document.
  assert.equal(folderDocumentPath(url, 'other'), null);
  assert.equal(folderDocumentPath('file:///tmp/a.md', 'my notes'), null);
});

/* -------------------------------------------------------------------------- */
/* Recovering real file:// URLs                                                */
/* -------------------------------------------------------------------------- */

test('base candidates are file:// only, deepest first, and percent-decoded', () => {
  assert.deepEqual(
    fileUrlBaseCandidates('file:///Users/me/notes/vendor/notes/a.md', 'notes'),
    ['file:///Users/me/notes/vendor/notes/', 'file:///Users/me/notes/'],
  );

  assert.deepEqual(
    fileUrlBaseCandidates('file:///Users/me/my%20notes/a.md', 'my notes'),
    ['file:///Users/me/my%20notes/'],
  );

  // The document itself can never be the directory, whatever it is called.
  assert.deepEqual(fileUrlBaseCandidates('file:///Users/notes/notes', 'notes'), [
    'file:///Users/notes/',
  ]);

  assert.deepEqual(fileUrlBaseCandidates('https://example.com/notes/a.md', 'notes'), []);
  assert.deepEqual(fileUrlBaseCandidates('not a url', 'notes'), []);
});

test('relativePathFrom decodes and refuses anything outside the base', () => {
  assert.equal(
    relativePathFrom('file:///Users/me/notes/', 'file:///Users/me/notes/sub/a%20b.md'),
    'sub/a b.md',
  );
  assert.equal(
    relativePathFrom('file:///Users/me/notes/', 'file:///Users/me/other/a.md'),
    null,
  );
  assert.equal(relativePathFrom('file:///Users/me/notes/', 'file:///Users/me/notes/'), null);
});

test('fileUrlFor re-encodes every segment', () => {
  assert.equal(
    fileUrlFor('file:///Users/me/notes/', 'sub dir/a b.md'),
    'file:///Users/me/notes/sub%20dir/a%20b.md',
  );
});

test('a base is only accepted once the bytes on disk match what is on screen', async () => {
  const root = directory('notes', { sub: { 'a.md': '# hello\nworld\n' } });

  assert.equal(
    await resolveFileUrlBase(root, 'file:///Users/me/notes/sub/a.md', '# hello\nworld\n'),
    'file:///Users/me/notes/',
  );

  // Same folder name, same relative path, different file: a real possibility on
  // any machine with two checkouts, and the one case that must never resolve.
  assert.equal(
    await resolveFileUrlBase(root, 'file:///elsewhere/notes/sub/a.md', '# something else\n'),
    null,
  );

  // The path does not exist inside the handle at all.
  assert.equal(
    await resolveFileUrlBase(root, 'file:///Users/me/notes/missing/a.md', 'anything'),
    null,
  );

  // Nothing to match against off file://.
  assert.equal(
    await resolveFileUrlBase(root, 'https://example.com/notes/sub/a.md', '# hello\nworld\n'),
    null,
  );
});

test('line endings and a BOM do not defeat the match', async () => {
  const root = directory('notes', { 'a.md': '﻿# hello\r\nworld\r\n' });

  assert.equal(
    await resolveFileUrlBase(root, 'file:///n/notes/a.md', '# hello\nworld\n'),
    'file:///n/notes/',
  );
});

test('the nearer of two same-named ancestors wins when both could match', async () => {
  const root = directory('notes', { 'a.md': 'inner' });

  assert.equal(
    await resolveFileUrlBase(root, 'file:///x/notes/deep/notes/a.md', 'inner'),
    'file:///x/notes/deep/notes/',
  );
});

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

test('a directory yields its subdirectories and its markdown, and nothing else', async () => {
  const root = directory('notes', {
    'b.md': '',
    'image.png': '',
    'a.markdown': '',
    node_modules: {},
    '.git': {},
    '.hidden.md': '',
    docs: {},
  });

  const { entries, truncated } = await readDirectory(root);

  assert.deepEqual(
    entries.map((entry) => `${entry.kind}:${entry.name}`),
    ['directory:docs', 'file:a.markdown', 'file:b.md'],
  );
  assert.equal(truncated, false);
});

test('paths are relative to the root, so they survive collapse and re-expand', async () => {
  const root = directory('notes', { docs: { 'a.md': '' } });
  const top = await readDirectory(root);
  const inner = await readDirectory(
    top.entries[0].handle as FileSystemDirectoryHandle,
    top.entries[0].path,
  );

  assert.equal(top.entries[0].path, 'docs');
  assert.equal(inner.entries[0].path, 'docs/a.md');
});

test('a huge directory is capped and says so rather than being silently short', async () => {
  const tree: Tree = {};
  for (let index = 0; index < FOLDER_ENTRY_LIMIT + 25; index += 1) {
    tree[`file-${String(index).padStart(5, '0')}.md`] = '';
  }

  const { entries, truncated } = await readDirectory(directory('big', tree));

  assert.equal(entries.length, FOLDER_ENTRY_LIMIT);
  assert.equal(truncated, true);
});
