/**
 * The sidebar, the outline, files and search, through the real host.
 *
 * This is the first plugin that *publishes* a region for other plugins to fill,
 * so what is asserted here is the region model itself rather than the sidebar's
 * pixels: the tab strip exists exactly while the sidebar does, the tabs are
 * ordered by `order` and not by import, and every one of the four unwinds
 * cleanly however many times it is toggled.
 *
 * The components are stand-ins, and that is a limitation of the runner rather
 * than a choice: `node --experimental-strip-types` cannot load a `.tsx` file at
 * all, so a plugin's UI half is unreachable from here. Everything except the
 * component therefore lives in a `.ts` module and the plugin is assembled by a
 * factory — so these are the real ids, the real regions, the real orders and
 * the real `setup`, with the one part the runner physically cannot import
 * replaced by a component that renders nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, before, test } from 'node:test';

import { JSDOM } from 'jsdom';

import { SharedDocument } from '../lib/plugins/document.ts';
import { PluginHost, type HostStorage } from '../lib/plugins/host.ts';
import type { AnyPlugin } from '../lib/plugins/types.ts';

import { createFilesPlugin } from '../plugins/files/plugin.ts';
import { createOutlinePlugin } from '../plugins/outline/plugin.ts';
import { createSearchPanelPlugin } from '../plugins/search-panel/plugin.ts';
import { createSidebarPlugin, SHELL_ASIDE_REGION } from '../plugins/sidebar/plugin.ts';
import { SidebarState } from '../plugins/sidebar/state.ts';
import { SIDEBAR_TAB_REGION, type PlacedSidebarTab } from '../plugins/sidebar/tabs.ts';

const NOTHING = () => null;

before(() => {
  // A window, because the shortcut registry binds one and `SidebarState` reads
  // `document.activeElement` to know where to put focus back.
  const dom = new JSDOM('<main class="mdv-body"></main>', {
    url: 'https://example.test/docs/a.md',
  });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of ['window', 'document', 'Node', 'HTMLElement', 'Element', 'KeyboardEvent']) {
    globals[name] = name === 'window' ? dom.window : (dom.window as never)[name];
  }
});

function memoryStorage(): HostStorage {
  let value: unknown = null;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/** Every plugin the sidebar migration produced, in registry order. */
function sidebarPlugins(): AnyPlugin[] {
  return [
    createSidebarPlugin(NOTHING),
    createOutlinePlugin(NOTHING),
    createFilesPlugin(NOTHING),
    createSearchPanelPlugin(NOTHING),
  ];
}

/**
 * Every host a test built, torn down after it.
 *
 * Not tidiness: a host's shortcut listener lives on `window`, and one left
 * running from an earlier test answers the chord first and marks the event
 * handled. One page has one host, so this is the runner catching up with
 * reality rather than a bug being papered over.
 */
const hosts: PluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

function makeHost(plugins: AnyPlugin[] = sidebarPlugins()) {
  const host = new PluginHost({
    plugins,
    storage: memoryStorage(),
    document: new SharedDocument(),
    logger: { warn: () => {}, error: () => {} },
  });

  // Standing in for `useShellRegions` in components/Viewer.tsx. The shell
  // publishes its own regions — the host declares only what a plugin
  // `provides` — and without this the sidebar's nav would have nowhere to go,
  // which is itself the region model working: an undeclared region is inert.
  host.regions.declare(SHELL_ASIDE_REGION);
  hosts.push(host);
  return host;
}

const tabKeys = (host: PluginHost) =>
  host.regions.for(SIDEBAR_TAB_REGION).map((entry) => entry.key);

/* -------------------------------------------------------------------------- */
/* The region, and who owns it                                                 */
/* -------------------------------------------------------------------------- */

test('the sidebar publishes sidebar.tab, and the tabs fill it in order', async () => {
  const host = makeHost();
  await host.start();

  assert.equal(host.regions.has(SIDEBAR_TAB_REGION), true);
  assert.deepEqual(tabKeys(host), ['outline', 'files', 'search']);

  // The label rides on the contribution, because `UiContribution` carries no
  // metadata and a tab button has to say what it opens.
  assert.deepEqual(
    (host.regions.for(SIDEBAR_TAB_REGION) as readonly PlacedSidebarTab[]).map(
      (tab) => tab.label,
    ),
    ['Outline', 'Files', 'Search'],
  );
});

test('tab order comes from `order`, never from the order plugins were listed', async () => {
  // Registered backwards on purpose: if the strip followed the registry the
  // reader would get Search, Files, Outline.
  const host = makeHost([
    createSidebarPlugin(NOTHING),
    createSearchPanelPlugin(NOTHING),
    createFilesPlugin(NOTHING),
    createOutlinePlugin(NOTHING),
  ]);
  await host.start();

  assert.deepEqual(tabKeys(host), ['outline', 'files', 'search']);
});

test('sidebar.tab exists only while the sidebar is enabled', async () => {
  const host = makeHost();
  await host.start();
  assert.equal(tabKeys(host).length, 3);

  await host.setEnabled('sidebar', false);

  // Inert, not broken: the tabs are still enabled plugins, still hold their
  // contributions, and nothing rendered or threw. This is what a reader turning
  // the sidebar off is supposed to get.
  assert.equal(host.regions.has(SIDEBAR_TAB_REGION), false);
  assert.deepEqual(tabKeys(host), []);
  assert.equal(host.regions.for(SHELL_ASIDE_REGION).length, 0, 'the nav survived');
  assert.deepEqual(
    host.statuses().filter((status) => status.enabled).map((status) => status.id),
    ['outline', 'files', 'search-panel'],
  );
  assert.equal(
    host.statuses().every((status) => status.failure === undefined),
    true,
    'disabling the region owner was reported as a failure somewhere',
  );

  await host.setEnabled('sidebar', true);
  assert.deepEqual(tabKeys(host), ['outline', 'files', 'search']);
});

test('the sidebar contributes exactly one thing to the shell column', async () => {
  const host = makeHost();
  await host.start();

  // `entrypoints/viewer.css` gives `.mdv-with-toc > nav` the sidebar's flex
  // track and `.mdv > :not(nav)` hands every other child a document-sized one,
  // so a second element here would be a second column.
  assert.equal(host.regions.for(SHELL_ASIDE_REGION).length, 1);
  assert.deepEqual(
    host.regions.for(SHELL_ASIDE_REGION).map((entry) => entry.pluginId),
    ['sidebar'],
  );
});

test('exactly one <nav> is rendered, and the shell renders none', () => {
  // The runner cannot mount a `.tsx`, so the one-nav rule is checked where it
  // is written. Crude, and still the difference between one column and two.
  // An opening JSX tag on its own line, which is what neither the prose above
  // it nor a closing tag can be mistaken for.
  const opensNav = /^\s*<nav$/gm;

  const nav = readFileSync('plugins/sidebar/SidebarNav.tsx', 'utf8');
  assert.equal(nav.match(opensNav)?.length, 1);

  const shell = readFileSync('components/Viewer.tsx', 'utf8');
  assert.equal(shell.match(/<nav[\s>]/g), null, 'the shell renders a nav of its own');
  assert.equal(
    /className=[^\n]*mdv-with-toc/.test(shell),
    false,
    'the shell still decides the sidebar layout mode',
  );
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

test('disabling one tab removes that tab and nothing else', async () => {
  const host = makeHost();
  await host.start();

  await host.setEnabled('outline', false);
  assert.deepEqual(tabKeys(host), ['files', 'search']);
  assert.equal(host.regions.has(SIDEBAR_TAB_REGION), true, 'the region went with it');

  await host.setEnabled('files', false);
  assert.deepEqual(tabKeys(host), ['search']);

  await host.setEnabled('outline', true);
  assert.deepEqual(tabKeys(host), ['outline', 'search'], 're-enabled out of order');
});

test('toggling repeatedly neither duplicates a tab nor strands one', async () => {
  const host = makeHost();
  await host.start();

  for (let round = 0; round < 4; round += 1) {
    await host.setEnabled('sidebar', false);
    await host.setEnabled('sidebar', true);
    await host.setEnabled('files', false);
    await host.setEnabled('files', true);
  }

  assert.deepEqual(tabKeys(host), ['outline', 'files', 'search']);
  assert.equal(host.regions.for(SHELL_ASIDE_REGION).length, 1);
  assert.notEqual(host.capabilities.use('sidebar'), undefined);
  assert.notEqual(host.capabilities.use('files.status'), undefined);
});

test('the sidebar takes its capability with it when it is disabled', async () => {
  const host = makeHost();
  await host.start();
  assert.notEqual(host.capabilities.use('sidebar'), undefined);

  await host.setEnabled('sidebar', false);
  assert.equal(host.capabilities.use('sidebar'), undefined);
});

/* -------------------------------------------------------------------------- */
/* The chord that opens Search                                                 */
/* -------------------------------------------------------------------------- */

function pressSearchChord() {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'F',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

test('the chord opens the Search tab through the capability, not an import', async () => {
  const host = makeHost();
  await host.start();

  const sidebar = host.capabilities.use('sidebar')!;
  assert.equal(sidebar.store.get().selected, null, 'a tab was selected before anything ran');

  pressSearchChord();

  const opened = sidebar.store.get();
  assert.equal(opened.selected, 'search');
  assert.equal(opened.expanded, true, 'a collapsed rail was not opened');
  assert.equal(opened.focusToken > 0, true, 'the panel was never told to take focus');
  assert.equal(opened.focusedKey, 'search');
});

test('the chord does nothing at all with the sidebar disabled', async () => {
  const host = makeHost();
  await host.start();
  await host.setEnabled('sidebar', false);

  // No sidebar to open, no error, no listener left believing otherwise. Quick
  // find — a different feature, and a fixed overlay — is what remains.
  assert.doesNotThrow(pressSearchChord);
  assert.equal(host.capabilities.use('sidebar'), undefined);
});

/* -------------------------------------------------------------------------- */
/* Tab selection, which used to be `Sidebar.tsx`'s hooks                       */
/* -------------------------------------------------------------------------- */

test('a shortcut has a way back; a click does not', () => {
  const state = new SidebarState();
  state.select('outline');

  state.openViaShortcut('search');
  assert.equal(state.store.get().selected, 'search');

  state.dismiss();
  assert.equal(state.store.get().selected, 'outline', 'Escape did not restore the tab');

  // Reached by clicking: there is no "before" to return to, and Escape ten
  // minutes later must not yank the reader off the tab they chose.
  state.select('files');
  state.dismiss();
  assert.equal(state.store.get().selected, 'files');
});

test('a remembered tab is honoured only while it exists and can work', () => {
  const state = new SidebarState();

  state.restore('files', ['outline', 'files', 'search']);
  assert.equal(state.store.get().selected, 'files');

  // The plugin behind it was disabled since it was stored.
  const gone = new SidebarState();
  gone.restore('files', ['outline', 'search']);
  assert.equal(gone.store.get().selected, 'outline');

  // Present, but useless in this browser: never land on it.
  const blocked = new SidebarState();
  blocked.report('files', { hint: 'This browser cannot open local folders.', blocked: true });
  blocked.restore('files', ['outline', 'files']);
  assert.equal(blocked.store.get().selected, 'outline');

  // Merely empty is still worth landing on — that is where the button to fill
  // it lives.
  const empty = new SidebarState();
  empty.report('files', { hint: 'No folder is open.' });
  empty.restore('files', ['outline', 'files']);
  assert.equal(empty.store.get().selected, 'files');
});

test('a tab reporting the same thing twice does not notify', () => {
  const state = new SidebarState();
  let notifications = 0;
  state.store.subscribe(() => {
    notifications += 1;
  });

  state.report('outline', { hint: 'This document has no headings.' });
  state.report('outline', { hint: 'This document has no headings.' });
  state.report('outline', { hint: 'This document has no headings.' });

  // Panels report from an effect that runs on every render of theirs; a store
  // that notified each time would re-render them and loop.
  assert.equal(notifications, 1);
});

test('the tab is persisted on selection, and only on selection', () => {
  const saved: string[] = [];
  const state = new SidebarState((tab) => saved.push(tab));

  state.select('files');
  state.setExpanded(false);
  state.report('files', { hint: null });
  state.openViaShortcut('search');
  state.openViaShortcut('search');

  assert.deepEqual(saved, ['files', 'search']);
});
