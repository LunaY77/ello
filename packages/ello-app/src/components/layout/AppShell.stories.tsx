import type { Meta, StoryObj } from '@storybook/react';

import { AppShell, TopBarFrame } from './AppShell';

import { Screen } from '@/testing/Storybook';


const meta = {
  title: 'Layout/AppShell',
  component: AppShell,
  args: { topBar: null, sidebar: null, children: null, rightPanel: null },
} satisfies Meta<typeof AppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

function Slot(props: { readonly label: string; readonly className?: string }) {
  return (
    <div className={`flex h-full items-center justify-center text-[12px] text-tertiary ${props.className ?? ''}`}>
      {props.label}
    </div>
  );
}

/** 三栏骨架:侧栏(可拖宽/折叠)+ 时间线 + 右栏(拖窄自动收起)。 */
export const Default: Story = {
  render: () => (
    <Screen>
      <AppShell
        topBar={
          <TopBarFrame
            leading={<span className="text-[13px] font-medium">feature/search-page / 给登录加验证码校验</span>}
            center={
              <span className="rounded-full border border-border-subtle bg-surface-2/70 px-3 py-1 text-[12px] text-secondary">
                claude-opus-4-8 · ask-before-changes
              </span>
            }
            trailing={<span className="text-[12px] text-tertiary">⌘K</span>}
          />
        }
        sidebar={<Slot label="Session Sidebar" />}
        rightPanel={<Slot label="Working Panel" />}
      >
        <Slot label="Chat Timeline" />
      </AppShell>
    </Screen>
  ),
};
