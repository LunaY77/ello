import type { Meta, StoryObj } from '@storybook/react';

import { TimelineEmpty } from './TimelineEmpty';

import { makeWorkspace } from '@/testing/fixtures-app';
import { Screen, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Timeline/TimelineEmpty',
  component: TimelineEmpty,
} satisfies Meta<typeof TimelineEmpty>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 品牌区:logo + 新建会话 + 快捷键速查。 */
export const NoThread: Story = {
  args: { variant: 'no-thread' },
  render: (args) => (
    <Screen>
      <TimelineEmpty variant={args.variant} />
    </Screen>
  ),
};

/** 新会话引导:示例任务卡 + 模式说明;工作区上下文注入副标题。 */
export const EmptyThread: Story = {
  args: { variant: 'empty-thread' },
  parameters: {
    store: ((state) => ({
      ...state,
      view: { ...state.view, selectedWorkspaceId: 'ws-search-page' },
      entities: {
        ...state.entities,
        workspaces: { 'ws-search-page': makeWorkspace() },
      },
    })) satisfies StoreSeed,
  },
  render: (args) => (
    <Screen>
      <TimelineEmpty variant={args.variant} />
    </Screen>
  ),
};
