import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';
import { useState } from 'react';

import { CreateWorkspacePopover } from './CreateWorkspacePopover';

import { Button } from '@/components/ui/Button';
import { REPOSITORIES } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const withRepos: StoreSeed = (state) => ({
  ...state,
  entities: { ...state.entities, repos: REPOSITORIES },
});

const meta = {
  title: 'Workspace/CreateWorkspacePopover',
  component: CreateWorkspacePopover,
  args: { trigger: null, open: true, onOpenChange: () => undefined },
  parameters: { store: withRepos },
} satisfies Meta<typeof CreateWorkspacePopover>;

export default meta;
type Story = StoryObj<typeof meta>;

function OpenStory() {
  const [open, setOpen] = useState(true);
  return (
    <Padded>
      <CreateWorkspacePopover
        open={open}
        onOpenChange={setOpen}
        trigger={<Button variant="primary">新建任务</Button>}
      />
    </Padded>
  );
}

export const Open: Story = {
  render: () => <OpenStory />,
  play: async () => {
    const body = within(document.body);
    const name = await body.findByPlaceholderText('任务名称,如 search-page');
    await userEvent.type(name, 'auth rate limit');
    await userEvent.click(body.getByRole('button', { name: 'ello' }));
    await expect(body.getByRole('button', { name: '创建并打开' })).toBeEnabled();
    await expect(body.getByText('feature/auth-rate-limit')).toBeInTheDocument();
  },
};
