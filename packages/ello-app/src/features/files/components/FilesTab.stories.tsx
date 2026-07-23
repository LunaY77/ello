import type { Meta, StoryObj } from '@storybook/react';

import { FilesTab } from './FilesTab';

import { makeWorkspace } from '@/testing/fixtures-app';
import { Padded, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'WorkPanel/FilesTab',
  component: FilesTab,
} satisfies Meta<typeof FilesTab>;

export default meta;
type Story = StoryObj<typeof meta>;

const workspace = makeWorkspace();
const withWorkspace: StoreSeed = (state) => ({
  ...state,
  entities: {
    ...state.entities,
    workspaces: { [workspace.id]: workspace },
  },
  view: { ...state.view, selectedWorkspaceId: workspace.id },
});

export const Tree: Story = {
  parameters: {
    store: withWorkspace,
    files: {
      directories: {
        [`${workspace.rootPath}\n.`]: [
          { name: 'src', path: 'src', kind: 'directory' },
          { name: 'tests', path: 'tests', kind: 'directory' },
          { name: 'package.json', path: 'package.json', kind: 'file' },
          { name: 'README.md', path: 'README.md', kind: 'file' },
        ],
      },
      files: {},
    },
  },
  render: () => (
    <Padded width={420}>
      <div className="flex h-[520px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-subtle">
        <FilesTab />
      </div>
    </Padded>
  ),
};

export const NoWorkspace: Story = {
  render: () => (
    <Padded width={420}>
      <div className="h-[360px] rounded-xl border border-border-subtle bg-subtle">
        <FilesTab />
      </div>
    </Padded>
  ),
};
