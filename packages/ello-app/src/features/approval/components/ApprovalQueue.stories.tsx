import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from '@storybook/test';

import { ApprovalQueue } from './ApprovalQueue';

import type { PendingRequestEntry } from '@/store/types';
import {
  APPROVAL_COMMAND,
  APPROVAL_COMMAND_DANGEROUS,
  APPROVAL_FILE_CHANGE,
  APPROVAL_USER_INPUT,
} from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Approval/ApprovalQueue',
  component: ApprovalQueue,
} satisfies Meta<typeof ApprovalQueue>;

export default meta;
type Story = StoryObj<typeof meta>;

function withRequests(entries: readonly PendingRequestEntry[]): StoreSeed {
  return (state) => ({
    ...state,
    view: { ...state.view, selectedThreadId: 'thread-rich' },
    interaction: { pendingRequests: entries },
  });
}

function renderQueue() {
  return (
    <Padded width={760}>
      <ApprovalQueue />
    </Padded>
  );
}

export const Command: Story = {
  parameters: { store: withRequests([APPROVAL_COMMAND]) },
  render: renderQueue,
};

export const DangerousCommand: Story = {
  parameters: { store: withRequests([APPROVAL_COMMAND_DANGEROUS]) },
  render: renderQueue,
};

export const UserInput: Story = {
  parameters: { store: withRequests([APPROVAL_USER_INPUT]) },
  render: renderQueue,
};

export const MultipleRequests: Story = {
  parameters: {
    store: withRequests([APPROVAL_COMMAND, APPROVAL_FILE_CHANGE, APPROVAL_USER_INPUT]),
  },
  render: renderQueue,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('1/3')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: '下一条' }));
    await expect(canvas.getByText('2/3')).toBeInTheDocument();
    await expect(canvas.getByText('文件修改')).toBeInTheDocument();
  },
};
