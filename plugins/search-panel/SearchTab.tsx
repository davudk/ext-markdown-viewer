import { useSyncExternalStore } from 'react';

import { SearchPanel } from '../../components/SearchPanel.tsx';
import {
  SidebarPanel,
  useCapability,
  useLiveDocument,
  useSidebarTab,
} from '../sidebar/context.tsx';
import type { FolderStatus, OpenedDocument } from '../files/types.ts';

import { SEARCH_TAB } from './plugin.ts';

/**
 * Search, wired into the tab strip.
 *
 * Three of its props come from places a contribution cannot be handed: the
 * document, the surface it renders on, and two things that belong to other
 * plugins. `folderStatus` is the Files tab's, read through a capability — with
 * Files disabled it is simply `idle`, and the panel goes on searching the
 * document on screen, which is what it does with no folder open anyway.
 */
export function SearchTab() {
  const { visible, focusToken, dismiss } = useSidebarTab(SEARCH_TAB.key);
  const rendered = useLiveDocument();
  const open = useCapability('document.open');
  const published = useCapability('files.status');

  const folderStatus = useSyncExternalStore<FolderStatus>(
    published?.subscribe ?? NO_SUBSCRIBE,
    () => published?.get() ?? 'idle',
  );

  return (
    <SidebarPanel tab={SEARCH_TAB.key}>
      <SearchPanel
        source={rendered.source}
        headings={rendered.headings}
        visible={visible}
        folderStatus={folderStatus}
        focusToken={focusToken}
        onClose={dismiss}
        onOpenDocument={open ?? noop}
      />
    </SidebarPanel>
  );
}

const NO_SUBSCRIBE = () => () => {};

function noop(_document: OpenedDocument) {}
