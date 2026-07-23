import type { Meta, StoryObj } from '@storybook/react';

import { ChatTimeline } from './ChatTimeline';

import { makeRichSnapshot } from '@/testing/fixtures-app';
import { Screen, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Timeline/ChatTimeline',
  component: ChatTimeline,
} satisfies Meta<typeof ChatTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

const withRichThread: StoreSeed = (state) => {
  const snapshot = makeRichSnapshot();
  return {
    ...state,
    view: { ...state.view, selectedThreadId: snapshot.thread.id },
    entities: {
      ...state.entities,
      threads: { [snapshot.thread.id]: snapshot.thread },
      snapshots: { [snapshot.thread.id]: snapshot },
    },
  };
};

/** 完整会话:已完成回合 + 进行中回合(流式),回合分隔线清晰。 */
export const Live: Story = {
  parameters: { store: withRichThread },
  render: () => (
    <Screen>
      <ChatTimeline />
    </Screen>
  ),
};

/** 无选中会话:品牌空状态。 */
export const NoThread: Story = {
  render: () => (
    <Screen>
      <ChatTimeline />
    </Screen>
  ),
};

/** 新会话(0 回合):引导卡 + 示例任务。 */
export const EmptyThread: Story = {
  parameters: {
    store: ((state) => {
      const snapshot = makeRichSnapshot();
      return {
        ...state,
        view: { ...state.view, selectedThreadId: snapshot.thread.id },
        entities: {
          ...state.entities,
          threads: { [snapshot.thread.id]: snapshot.thread },
          snapshots: {
            [snapshot.thread.id]: { ...snapshot, turns: [], thread: { ...snapshot.thread, status: 'idle' } },
          },
        },
      };
    }) satisfies StoreSeed,
  },
  render: () => (
    <Screen>
      <ChatTimeline />
    </Screen>
  ),
};
