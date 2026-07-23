import type { Meta, StoryObj } from '@storybook/react';

import { ModelPicker } from './ModelPicker';

import { MODEL_ENTRIES } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const withModels: StoreSeed = (state) => ({
  ...state,
  entities: {
    ...state.entities,
    catalogs: { ...state.entities.catalogs, models: MODEL_ENTRIES },
  },
});

const meta = {
  title: 'Composer/ModelPicker',
  component: ModelPicker,
  args: {
    threadId: 'thread-story',
    cwd: '/data/workspace/search-page',
    model: 'claude-opus-4-8',
  },
  parameters: { store: withModels, layout: 'centered' },
} satisfies Meta<typeof ModelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Padded>
      <ModelPicker {...args} />
    </Padded>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
  render: (args) => (
    <Padded>
      <ModelPicker {...args} />
    </Padded>
  ),
};
