import type { Meta, StoryObj } from '@storybook/react';
import { Copy, Moon, PanelRight, Settings, Trash2 } from 'lucide-react';

import { IconButton } from './IconButton';

import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/IconButton',
  component: IconButton,
  args: { icon: <Settings size={15} />, tooltip: '设置' },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <Padded>
      <div className="flex items-center gap-2">
        <IconButton icon={<Settings size={15} />} tooltip="设置" />
        <IconButton icon={<Moon size={15} />} tooltip="切换到深色" />
        <IconButton icon={<PanelRight size={15} />} tooltip="工作面板 (⌘J)" active />
        <IconButton icon={<Copy size={15} />} tooltip="复制" disabled />
        <IconButton icon={<Trash2 size={15} />} tooltip="删除(危险)" className="hover:text-danger" />
      </div>
    </Padded>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Padded>
      <div className="flex items-end gap-2">
        <IconButton icon={<Settings size={12} />} tooltip="24px" size={24} />
        <IconButton icon={<Settings size={15} />} tooltip="28px" size={28} />
        <IconButton icon={<Settings size={18} />} tooltip="32px" size={32} />
      </div>
    </Padded>
  ),
};
