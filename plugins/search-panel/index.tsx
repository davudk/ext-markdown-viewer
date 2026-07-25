import { createSearchPanelPlugin } from './plugin.ts';
import { SearchTab } from './SearchTab.tsx';

export const searchPanelPlugin = createSearchPanelPlugin(SearchTab);
