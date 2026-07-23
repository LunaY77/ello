/**
 * 命令面板的命令注册表。命令执行只调领域操作与状态修改函数,
 * 面板自身不持有业务逻辑。打开状态放这里,顶栏按钮与 Cmd+K 共用。
 */
import type { SessionMode } from '@ello/agent/protocol';
import {
  Columns2,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react';
import { create } from 'zustand';

import {
  newThreadInContext,
  setThreadMode,
  setThreadModel,
} from '@/features/thread';
import { appMutations, useAppStore } from '@/store/store';

interface PaletteState {
  readonly open: boolean;
  setOpen: (open: boolean) => void;
}

export const usePaletteStore = create<PaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly icon?: typeof Sun;
  readonly shortcut?: string;
  readonly keywords: string;
  readonly enabled: () => boolean;
  readonly run: () => void;
  /** 有二级页的命令(栈式 drill,不弹新层)。 */
  readonly drill?: 'models';
}

const MODE_KEYWORDS: Record<SessionMode, string> = {
  'ask-before-changes': '审批 谨慎 ask',
  'accept-edits': '自动编辑 accept',
  plan: '计划 plan',
  bypass: '绕过 bypass',
};

export function buildCommands(navigate: (path: string) => void): readonly PaletteCommand[] {
  const { setTheme, toggleRightPanel, toggleSidebar } = appMutations;
  const hasThread = () => useAppStore.getState().view.selectedThreadId !== null;
  const withThread = (fn: (threadId: string) => void) => () => {
    const threadId = useAppStore.getState().view.selectedThreadId;
    if (threadId !== null) fn(threadId);
  };
  return [
    {
      id: 'new-thread',
      label: '新建会话',
      icon: MessageSquarePlus,
      shortcut: '⌘N',
      keywords: 'new chat thread xinjian',
      enabled: () => true,
      run: () => void newThreadInContext(),
    },
    {
      id: 'toggle-sidebar',
      label: '切换侧栏',
      icon: PanelLeft,
      shortcut: '⌘B',
      keywords: 'sidebar cebian',
      enabled: () => true,
      run: toggleSidebar,
    },
    {
      id: 'toggle-panel',
      label: '切换工作面板',
      icon: Columns2,
      shortcut: '⌘J',
      keywords: 'panel files gongzuo',
      enabled: () => true,
      run: toggleRightPanel,
    },
    {
      id: 'open-skills',
      label: '打开技能管理',
      icon: Sparkles,
      keywords: 'skills jineng',
      enabled: () => true,
      run: () => navigate('/skills'),
    },
    {
      id: 'open-settings',
      label: '打开设置',
      icon: Settings,
      shortcut: '⌘,',
      keywords: 'settings shezhi',
      enabled: () => true,
      run: () => navigate('/settings'),
    },
    {
      id: 'theme-light',
      label: '切换到浅色主题',
      icon: Sun,
      keywords: 'theme light qianse zhuti',
      enabled: () => useAppStore.getState().preferences.theme !== 'light',
      run: () => setTheme('light'),
    },
    {
      id: 'theme-dark',
      label: '切换到深色主题',
      icon: Moon,
      keywords: 'theme dark shense zhuti',
      enabled: () => useAppStore.getState().preferences.theme !== 'dark',
      run: () => setTheme('dark'),
    },
    {
      id: 'theme-system',
      label: '主题跟随系统',
      icon: Settings,
      keywords: 'theme system xitong zhuti',
      enabled: () => useAppStore.getState().preferences.theme !== 'system',
      run: () => setTheme('system'),
    },
    ...(['ask-before-changes', 'accept-edits', 'plan', 'bypass'] as const).map(
      (mode): PaletteCommand => ({
        id: `mode-${mode}`,
        label: `会话模式:${mode}`,
        keywords: `mode ${MODE_KEYWORDS[mode]}`,
        enabled: hasThread,
        run: withThread((threadId) => void setThreadMode(threadId, mode)),
      }),
    ),
    {
      id: 'pick-model',
      label: '选择模型…',
      shortcut: '⌘M',
      keywords: 'model moxing',
      enabled: hasThread,
      run: () => undefined,
      drill: 'models',
    },
  ];
}

export function pickModel(modelId: string): void {
  const threadId = useAppStore.getState().view.selectedThreadId;
  if (threadId !== null) void setThreadModel(threadId, modelId);
}
