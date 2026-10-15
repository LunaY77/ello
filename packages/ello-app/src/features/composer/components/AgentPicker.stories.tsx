import type { Meta, StoryObj } from '@storybook/react';

import { AgentPicker } from './AgentPicker';

import { AGENT_ENTRIES } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const withAgents: StoreSeed = (state) => ({
  ...state,
  entities: {
    ...state.entities,
    catalogs: { ...state.entities.catalogs, agents: AGENT_ENTRIES },
  },
});

const meta = {
  title: 'Composer/AgentPicker',
  component: AgentPicker,
  args: {
    threadId: 'thread-story',
    cwd: '/data/workspace/search-page',
    agent: 'build',
  },
  parameters: { store: withAgents, layout: 'centered' },
} satisfies Meta<typeof AgentPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Padded>
      <AgentPicker {...args} />
    </Padded>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <Padded>
      <AgentPicker {...args} />
    </Padded>
  ),
};
