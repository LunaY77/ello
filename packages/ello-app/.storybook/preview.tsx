import type { Preview } from '@storybook/react';

import {
  resetAllStores,
  ThemeBridge,
  type ComposerStorySeed,
  type FilesStorySeed,
  type StoreSeed,
} from '../src/testing/Storybook';

import '../src/styles/globals.css';

/**
 * 全局约定:toolbar 切换明暗主题(data-theme 原子切换,与 app 内行为一致);
 * 每个 story 渲染前重置全部模块 store,story 之间零泄漏。
 */
const preview: Preview = {
  globalTypes: {
    theme: {
      name: '主题',
      description: '明暗双主题',
      defaultValue: 'light',
      toolbar: {
        icon: 'mirror',
        items: [
          { value: 'light', title: '浅色' },
          { value: 'dark', title: '深色' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      resetAllStores({
        store: context.parameters['store'] as StoreSeed | undefined,
        paletteOpen: context.parameters['paletteOpen'] as boolean | undefined,
        composer: context.parameters['composer'] as ComposerStorySeed | undefined,
        files: context.parameters['files'] as FilesStorySeed | undefined,
      });
      return (
        <ThemeBridge theme={context.globals['theme'] as 'light' | 'dark'}>
          <Story />
        </ThemeBridge>
      );
    },
  ],
  parameters: {
    layout: 'fullscreen',
    backgrounds: { disable: true },
    controls: { expanded: true },
  },
};

export default preview;
