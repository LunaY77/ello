import type { Meta, StoryObj } from '@storybook/react';

import { DiffView } from './DiffView';

import { SAMPLE_DIFF } from '@/testing/fixtures-app';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/DiffView',
  component: DiffView,
  args: { diff: SAMPLE_DIFF },
} satisfies Meta<typeof DiffView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 半透明色块 + 双行号 gutter + hunk 分隔。 */
export const Default: Story = {
  args: { diff: SAMPLE_DIFF },
  render: (args) => (
    <Padded width={720}>
      <DiffView diff={args.diff} />
    </Padded>
  ),
};

/** 截断模式:超出部分折叠为计数条。 */
export const Truncated: Story = {
  render: () => (
    <Padded width={720}>
      <DiffView diff={SAMPLE_DIFF} maxLines={8} />
    </Padded>
  ),
};

/** 非法 diff 直接抛错(fail fast),由 Storybook 展示错误边界。 */
export const Malformed: Story = {
  render: () => (
    <Padded width={720}>
      <DiffView diff={'@@ 这不是合法的 hunk 头 @@\n+added line'} />
    </Padded>
  ),
};
