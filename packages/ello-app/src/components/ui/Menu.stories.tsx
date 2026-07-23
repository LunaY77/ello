import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from '@storybook/test';
import { Archive, Download, GitBranch, Trash2 } from 'lucide-react';

import { Menu } from './Menu';

import { Button } from '@/components/ui/Button';
import { Padded } from '@/testing/Storybook';


const ITEMS = [
  { id: 'archive', label: '归档', icon: <Archive size={14} /> },
  { id: 'export', label: '导出 Markdown', icon: <Download size={14} />, shortcut: '⌘E' },
  { id: 'fork', label: '派生分支', icon: <GitBranch size={14} /> },
  { id: 'disabled', label: '不可用操作', disabled: true },
  { id: 'delete', label: '删除', icon: <Trash2 size={14} />, danger: true },
] as const;

const trigger = ({ toggle, ref, open }: Parameters<NonNullable<React.ComponentProps<typeof Menu>['trigger']>>[0]) => (
  <span ref={ref}>
    <Button variant="secondary" onClick={toggle}>{open ? '关闭菜单' : '打开菜单'}</Button>
  </span>
);

const renderMenu = (args: React.ComponentProps<typeof Menu>) => (
  <Padded>
    <Menu {...args} />
  </Padded>
);

const meta = {
  title: 'UI/Menu',
  component: Menu,
  args: { items: ITEMS, onSelect: fn(), trigger },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { onSelect: fn() },
  render: renderMenu,
};

/** 键盘路径:打开 → ↓ 移动(跳过禁用项)→ Enter 执行。 */
export const KeyboardNavigation: Story = {
  args: { onSelect: fn() },
  render: renderMenu,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '打开菜单' }));
    const body = within(document.body);
    await body.findByRole('dialog');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    await expect(args.onSelect).toHaveBeenCalledWith('export');
  },
};
