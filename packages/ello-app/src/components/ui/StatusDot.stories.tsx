import type { Meta, StoryObj } from '@storybook/react';

import { StatusDot } from './StatusDot';

import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/StatusDot',
  component: StatusDot,
  args: { status: 'idle' },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 运行中(呼吸)> 待审批 > 失败 > 空闲,颜色配合形状/动效双编码。 */
export const Statuses: Story = {
  render: () => (
    <Padded>
      <div className="flex flex-col gap-2.5">
        {(
          [
            ['running', '运行中'],
            ['attention', '待审批'],
            ['failed', '失败'],
            ['idle', '空闲'],
          ] as const
        ).map(([status, label]) => (
          <div key={status} className="flex items-center gap-2 text-[12px] text-secondary">
            <StatusDot status={status} />
            {label}
            <span className="font-mono text-[10px] text-disabled">{status}</span>
          </div>
        ))}
      </div>
    </Padded>
  ),
};
