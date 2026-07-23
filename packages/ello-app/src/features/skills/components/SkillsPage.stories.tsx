import type { Meta, StoryObj } from '@storybook/react';

import { SkillsPage } from './SkillsPage';

import { SKILL_ENTRIES, makeWorkspace } from '@/testing/fixtures-app';
import { Screen, withRouter, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Pages/SkillsPage',
  component: SkillsPage,
} satisfies Meta<typeof SkillsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const withSkills: StoreSeed = (state) => {
  const workspace = makeWorkspace();
  return {
    ...state,
    entities: {
      ...state.entities,
      workspaces: { [workspace.id]: workspace },
      catalogs: { ...state.entities.catalogs, skills: SKILL_ENTRIES },
    },
    view: { ...state.view, selectedWorkspaceId: workspace.id },
  };
};

export const Catalog: Story = {
  parameters: { store: withSkills },
  render: () => withRouter(<Screen><SkillsPage /></Screen>),
};

export const MissingWorkspace: Story = {
  render: () => withRouter(<Screen><SkillsPage /></Screen>),
};
