import type { Meta, StoryObj } from '@storybook/react';
import { FolderOpen } from 'lucide-react';

import { EmptyState } from './EmptyState';

import { Button } from '@/components/ui/Button';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/EmptyState',
  component: EmptyState,
  args: { icon: <FolderOpen size={20} />, title: '未选择工作区' },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: <FolderOpen size={20} />,
    title: '未选择工作区',
    description: '在侧栏选择一个工作区后,这里显示它的文件树。',
  },
  render: (args) => (
    <Padded>
      <EmptyState {...args} />
    </Padded>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Padded>
      <EmptyState
        icon={<FolderOpen size={20} />}
        title="还没有会话"
        description="新建一个会话,开始和 ello 一起工作。"
        action={<Button variant="primary">新建会话</Button>}
      />
    </Padded>
  ),
};
