import type { Meta, StoryObj } from '@storybook/react';
import { Copy } from 'lucide-react';

import { Tooltip, TooltipShortcut } from './Tooltip';

import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/Tooltip',
  component: Tooltip,
  args: { content: '提示', children: <span>目标</span> },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** hover 350ms 后出现;键盘 focus 立现。 */
export const Placements: Story = {
  render: () => (
    <Padded>
      <div className="flex items-center gap-6 py-8">
        {(['top', 'bottom', 'left', 'right'] as const).map((placement) => (
          <Tooltip
            key={placement}
            content={
              <>
                复制到剪贴板 <TooltipShortcut keys="⌘C" />
              </>
            }
            placement={placement}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md border border-border-subtle bg-surface-1 text-tertiary">
              <Copy size={14} />
            </span>
          </Tooltip>
        ))}
      </div>
    </Padded>
  ),
};
