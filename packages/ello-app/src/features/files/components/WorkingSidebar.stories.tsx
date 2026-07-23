import type { Meta, StoryObj } from '@storybook/react';

import { WorkingSidebar } from './WorkingSidebar';

import { makeRichSnapshot } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'WorkPanel/WorkingSidebar',
  component: WorkingSidebar,
} satisfies Meta<typeof WorkingSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

const withChangesTab: StoreSeed = (state) => {
  const snapshot = makeRichSnapshot();
  return {
    ...state,
    entities: {
      ...state.entities,
      threads: { [snapshot.thread.id]: snapshot.thread },
      snapshots: { [snapshot.thread.id]: snapshot },
    },
    view: {
      ...state.view,
      selectedThreadId: snapshot.thread.id,
      rightPanel: { tab: 'changes', visible: true },
    },
  };
};

export const ChangesSelected: Story = {
  parameters: { store: withChangesTab },
  render: () => (
    <Padded width={440}>
      <div className="flex h-[700px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-subtle">
        <WorkingSidebar />
      </div>
    </Padded>
  ),
};
