import type { Meta, StoryObj } from '@storybook/react';

import { TaskBoard } from './TaskBoard';

import { makeTask } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'WorkPanel/TaskBoard',
  component: TaskBoard,
} satisfies Meta<typeof TaskBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

const withTasks: StoreSeed = (state) => {
  const running = makeTask();
  const pending = makeTask({
    id: 'task-2',
    subject: '补充锁定期边界测试',
    status: 'pending',
    owner: null,
    blockedBy: [running.id],
    updatedAt: '2026-07-22T05:30:00Z',
  });
  const completed = makeTask({
    id: 'task-3',
    subject: '验证码发送接口',
    status: 'completed',
    updatedAt: '2026-07-22T04:00:00Z',
  });
  const cancelled = makeTask({
    id: 'task-4',
    subject: '邮件发送通道',
    status: 'cancelled',
    owner: null,
    updatedAt: '2026-07-21T09:00:00Z',
  });
  return {
    ...state,
    entities: {
      ...state.entities,
      tasks: {
        [running.id]: running,
        [pending.id]: pending,
        [completed.id]: completed,
        [cancelled.id]: cancelled,
      },
    },
  };
};

export const Board: Story = {
  parameters: { store: withTasks },
  render: () => (
    <Padded width={420}>
      <div className="h-[620px] overflow-hidden rounded-xl border border-border-subtle bg-subtle">
        <TaskBoard />
      </div>
    </Padded>
  ),
};

export const Empty: Story = {
  render: () => (
    <Padded width={420}>
      <div className="h-[360px] rounded-xl border border-border-subtle bg-subtle">
        <TaskBoard />
      </div>
    </Padded>
  ),
};
