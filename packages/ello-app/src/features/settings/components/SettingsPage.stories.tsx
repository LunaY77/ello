import type { Meta, StoryObj } from '@storybook/react';

import { SettingsPage } from './SettingsPage';

import { Screen, withRouter, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Pages/SettingsPage',
  component: SettingsPage,
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const withSettings: StoreSeed = (state) => ({
  ...state,
  connection: {
    phase: 'fatal',
    serverInfo: null,
    fatalError: 'Sidecar exited before initialize completed.',
  },
  preferences: { ...state.preferences, theme: 'dark', enterToSend: false },
});

export const Default: Story = {
  parameters: { store: withSettings },
  render: () => withRouter(<Screen><SettingsPage /></Screen>),
};
