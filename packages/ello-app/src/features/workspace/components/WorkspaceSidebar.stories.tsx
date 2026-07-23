import type { Meta, StoryObj } from '@storybook/react';

import { WorkspaceSidebar } from './WorkspaceSidebar';

import { makeSummary } from '@/testing/fixtures';
import { makeWorkspace } from '@/testing/fixtures-app';
import { Screen, withRouter, type StoreSeed } from '@/testing/Storybook';


const meta = {
  title: 'Workspace/WorkspaceSidebar',
  component: WorkspaceSidebar,
} satisfies Meta<typeof WorkspaceSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

const withSidebarData: StoreSeed = (state) => {
  const feature = makeWorkspace();
  const fix = makeWorkspace({
    id: 'ws-auth-fix',
    kind: 'fix',
    name: 'auth-timeout',
    rootPath: '/data/workspace/auth-timeout',
    branch: 'fix/auth-timeout',
    updatedAt: '2026-07-21T07:00:00Z',
  });
  const running = makeSummary({
    id: 'thread-running',
    cwd: feature.rootPath,
    name: '给登录加验证码校验',
    status: 'running',
  });
  const approval = makeSummary({
    id: 'thread-approval',
    cwd: fix.rootPath,
    name: '排查认证超时',
    status: 'awaitingApproval',
    updatedAt: '2026-07-22T07:00:00Z',
  });
  const chat = makeSummary({
    id: 'thread-chat',
    cwd: '/data/workspace/chat',
    name: '',
    preview: '解释这个项目的鉴权流程',
    updatedAt: '2026-07-20T07:00:00Z',
  });
  return {
    ...state,
    entities: {
      ...state.entities,
      workspaces: { [feature.id]: feature, [fix.id]: fix },
      threads: { [running.id]: running, [approval.id]: approval, [chat.id]: chat },
    },
    view: {
      ...state.view,
      selectedWorkspaceId: feature.id,
      selectedThreadId: running.id,
    },
  };
};

function renderSidebar() {
  return withRouter(
    <Screen>
      <div className="h-full w-[280px] border-r border-border-subtle bg-sidebar-bg">
        <WorkspaceSidebar />
      </div>
    </Screen>,
  );
}

export const Expanded: Story = {
  parameters: { store: withSidebarData },
  render: renderSidebar,
};

export const Collapsed: Story = {
  parameters: {
    store: ((state) => {
      const seeded = withSidebarData(state);
      return {
        ...seeded,
        preferences: { ...seeded.preferences, sidebarCollapsed: true },
      };
    }) satisfies StoreSeed,
  },
  render: renderSidebar,
};

export const Empty: Story = {
  render: renderSidebar,
};
