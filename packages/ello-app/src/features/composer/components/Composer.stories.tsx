import type { Meta, StoryObj } from '@storybook/react';

import { Composer } from './Composer';

import { makeSnapshot, makeSummary } from '@/testing/fixtures';
import { MODEL_ENTRIES, makeRichSnapshot } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Composer/Composer',
  component: Composer,
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

const idleSnapshot = makeSnapshot({
  thread: makeSummary({
    id: 'thread-compose',
    cwd: '/data/workspace/search-page',
    name: '验证码登录',
  }),
});

const withIdleComposer: StoreSeed = (state) => ({
  ...state,
  connection: { phase: 'ready', serverInfo: null, fatalError: null },
  entities: {
    ...state.entities,
    threads: { [idleSnapshot.thread.id]: idleSnapshot.thread },
    snapshots: { [idleSnapshot.thread.id]: idleSnapshot },
    catalogs: { ...state.entities.catalogs, models: MODEL_ENTRIES },
  },
  view: { ...state.view, selectedThreadId: idleSnapshot.thread.id },
});

const withRunningComposer: StoreSeed = (state) => {
  const snapshot = makeRichSnapshot();
  return {
    ...state,
    connection: { phase: 'ready', serverInfo: null, fatalError: null },
    entities: {
      ...state.entities,
      threads: { [snapshot.thread.id]: snapshot.thread },
      snapshots: { [snapshot.thread.id]: snapshot },
      catalogs: { ...state.entities.catalogs, models: MODEL_ENTRIES },
    },
    view: { ...state.view, selectedThreadId: snapshot.thread.id },
  };
};

function renderComposer() {
  return (
    <Padded width={820}>
      <div className="rounded-xl border border-border-subtle bg-canvas py-4">
        <Composer />
      </div>
    </Padded>
  );
}

export const DraftWithAttachment: Story = {
  parameters: {
    store: withIdleComposer,
    composer: {
      drafts: { 'thread-compose': '把验证码错误阈值改成 3 次,并补齐边界测试。' },
      attachments: {
        'thread-compose': [
          { path: '/data/workspace/search-page/docs/auth.md', displayName: 'auth.md' },
        ],
      },
      queues: {},
    },
  },
  render: renderComposer,
};

export const RunningWithQueue: Story = {
  parameters: {
    store: withRunningComposer,
    composer: {
      drafts: { 'thread-rich': '完成后再检查一下锁定期返回的剩余秒数。' },
      attachments: {},
      queues: {
        'thread-rich': [
          {
            input: [{ type: 'text', text: '补充生产环境灰度配置说明' }],
            preview: '补充生产环境灰度配置说明',
          },
        ],
      },
    },
  },
  render: renderComposer,
};

export const Disconnected: Story = {
  parameters: {
    store: ((state) => ({
      ...withIdleComposer(state),
      connection: { phase: 'idle', serverInfo: null, fatalError: null },
    })) satisfies StoreSeed,
  },
  render: renderComposer,
};
