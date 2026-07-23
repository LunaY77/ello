import type { Meta, StoryObj } from '@storybook/react';

import { Badge } from './Badge';

import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/Badge',
  component: Badge,
  args: { children: 'Badge' },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tones: Story = {
  render: () => (
    <Padded>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">default</Badge>
        <Badge tone="fluent">起草中</Badge>
        <Badge tone="success">已启用</Badge>
        <Badge tone="warning">需审批</Badge>
        <Badge tone="danger">高风险</Badge>
        <Badge tone="warning">2</Badge>
      </div>
    </Padded>
  ),
};
