import type { Meta, StoryObj } from '@storybook/react';

import { ModeSwitcher } from './ModeSwitcher';

import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'Composer/ModeSwitcher',
  component: ModeSwitcher,
  args: { threadId: 'thread-story', mode: 'ask-before-changes' },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ModeSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Modes: Story = {
  render: () => (
    <Padded>
      <div className="flex flex-wrap items-center gap-3">
        <ModeSwitcher threadId="thread-1" mode="ask-before-changes" />
        <ModeSwitcher threadId="thread-2" mode="accept-edits" />
        <ModeSwitcher threadId="thread-3" mode="plan" />
        <ModeSwitcher threadId="thread-4" mode="bypass" />
        <ModeSwitcher threadId="thread-5" mode="plan" disabled />
      </div>
    </Padded>
  ),
};
