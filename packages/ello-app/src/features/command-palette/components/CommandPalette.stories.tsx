import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';

import { CommandPalette } from './CommandPalette';

import { makeSummary } from '@/testing/fixtures';
import { MODEL_ENTRIES, makeWorkspace } from '@/testing/fixtures-app';
import { withRouter, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Navigation/CommandPalette',
  component: CommandPalette,
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

const withPaletteData: StoreSeed = (state) => {
  const workspace = makeWorkspace();
  const recent = makeSummary({
    id: 'thread-recent',
    cwd: workspace.rootPath,
    name: '给登录加验证码校验',
    status: 'running',
  });
  const approval = makeSummary({
    id: 'thread-approval',
    cwd: workspace.rootPath,
    name: '升级认证依赖',
    status: 'awaitingApproval',
    updatedAt: '2026-07-22T07:30:00Z',
  });
  return {
    ...state,
    entities: {
      ...state.entities,
      workspaces: { [workspace.id]: workspace },
      threads: { [recent.id]: recent, [approval.id]: approval },
      catalogs: { ...state.entities.catalogs, models: MODEL_ENTRIES },
    },
  };
};

export const Open: Story = {
  parameters: { paletteOpen: true, store: withPaletteData },
  render: () => withRouter(<CommandPalette />),
};

export const SearchCommands: Story = {
  parameters: { paletteOpen: true, store: withPaletteData },
  render: () => withRouter(<CommandPalette />),
  play: async () => {
    const body = within(document.body);
    const input = await body.findByRole('textbox', { name: '搜索命令' });
    await userEvent.type(input, '设置');
    await expect(body.getByText('打开设置')).toBeInTheDocument();
  },
};
