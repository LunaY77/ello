import type { Meta, StoryObj } from '@storybook/react';
import { Plus, Search } from 'lucide-react';

import { Button } from './Button';

import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <Padded>
      <div className="flex flex-col gap-4">
        {(['primary', 'secondary', 'subtle', 'danger'] as const).map((variant) => (
          <div key={variant} className="flex items-center gap-3">
            <span className="w-24 font-mono text-[11px] text-tertiary">{variant}</span>
            <Button variant={variant}>创建任务</Button>
            <Button variant={variant} size="sm">
              允许一次
            </Button>
            <Button variant={variant} disabled>
              已禁用
            </Button>
          </div>
        ))}
      </div>
    </Padded>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <Padded>
      <div className="flex items-center gap-3">
        <Button variant="primary" icon={<Plus size={15} />}>
          新建任务
        </Button>
        <Button variant="secondary" icon={<Search size={14} />}>
          搜索
        </Button>
      </div>
    </Padded>
  ),
};

export const LongLabel: Story = {
  render: () => (
    <Padded width={280}>
      <Button variant="secondary">始终允许(仅本次会话生效)</Button>
    </Padded>
  ),
};
