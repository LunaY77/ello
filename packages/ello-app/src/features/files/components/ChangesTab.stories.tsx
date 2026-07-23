import type { Meta, StoryObj } from '@storybook/react';

import { ChangesTab } from './ChangesTab';

import { makeRichSnapshot } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'WorkPanel/ChangesTab',
  component: ChangesTab,
} satisfies Meta<typeof ChangesTab>;

export default meta;
type Story = StoryObj<typeof meta>;

const withChanges: StoreSeed = (state) => {
  const snapshot = makeRichSnapshot();
  return {
    ...state,
    entities: {
      ...state.entities,
      threads: { [snapshot.thread.id]: snapshot.thread },
      snapshots: { [snapshot.thread.id]: snapshot },
    },
    view: { ...state.view, selectedThreadId: snapshot.thread.id },
  };
};

export const Changes: Story = {
  parameters: { store: withChanges },
  render: () => (
    <Padded width={620}>
      <div className="flex h-[640px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-subtle">
        <ChangesTab />
      </div>
    </Padded>
  ),
};

export const Empty: Story = {
  render: () => (
    <Padded width={420}>
      <div className="h-[360px] rounded-xl border border-border-subtle bg-subtle">
        <ChangesTab />
      </div>
    </Padded>
  ),
};
