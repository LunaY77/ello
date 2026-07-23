import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';

import { ToolRunGroup, type ToolRunItem } from './ToolRunGroup';

import {
  makeCommandItem,
  makeFileChangeItem,
  makeSubagentItem,
  makeToolCallItem,
} from '@/testing/fixtures-app';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'Timeline/ToolRunGroup',
  component: ToolRunGroup,
  args: { items: [] },
} satisfies Meta<typeof ToolRunGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

const TURN = 'turn-group';

export const Success: Story = {
  args: {
    items: [
      makeToolCallItem(TURN),
      makeCommandItem(TURN),
      makeFileChangeItem(TURN),
    ] as ToolRunItem[],
  },
  render: (args) => (
    <Padded width={720}>
      <ToolRunGroup items={args.items} />
    </Padded>
  ),
};

export const Running: Story = {
  render: () => (
    <Padded width={720}>
      <ToolRunGroup
        items={[
          makeCommandItem(TURN, { command: 'pnpm build', durationMs: 8200 }),
          makeCommandItem(TURN, {
            command: 'pnpm test:watch auth',
            status: 'inProgress',
            exitCode: undefined,
            durationMs: undefined,
            outputPreview: 'watching for file changes…\n',
          }),
        ]}
      />
    </Padded>
  ),
};

export const WithFailure: Story = {
  render: () => (
    <Padded width={720}>
      <ToolRunGroup
        items={[
          makeCommandItem(TURN, { command: 'pnpm build', durationMs: 3100 }),
          makeCommandItem(TURN, {
            command: 'pnpm e2e',
            status: 'failed',
            exitCode: 1,
            durationMs: 30_000,
            outputPreview: '✗ login.spec.ts › 验证码错误 3 次后锁定\n  TimeoutError: waiting for selector .locked-banner',
          }),
          makeSubagentItem(TURN),
        ]}
      />
    </Padded>
  ),
};

/** 就地展开:步骤行 + 三段式命令卡(顶栏/输出/底栏)。 */
export const Expanded: Story = {
  args: {
    items: [
      makeCommandItem(TURN),
      makeCommandItem(TURN, {
        command: 'pnpm e2e',
        status: 'failed',
        exitCode: 1,
        durationMs: 30_000,
        outputPreview: '✗ login.spec.ts › 验证码错误 3 次后锁定\n  TimeoutError: waiting for selector .locked-banner',
      }),
      makeFileChangeItem(TURN),
    ] as ToolRunItem[],
  },
  render: (args) => (
    <Padded width={720}>
      <ToolRunGroup items={args.items} />
    </Padded>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // 展开胶囊 → 步骤列表;再展开失败步骤 → 三段式命令卡。
    await userEvent.click(canvas.getByRole('button', { name: /已执行 3 个步骤/ }));
    await userEvent.click(canvas.getByRole('button', { name: /pnpm e2e/ }));
    await expect(canvas.getByText('exit 1')).toBeInTheDocument();
    await expect(canvas.getByText(/TimeoutError/)).toBeInTheDocument();
  },
};
