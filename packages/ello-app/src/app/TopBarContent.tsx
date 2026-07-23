import { Command, Moon, PanelRight, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';

import { IconButton } from '@/components/ui/IconButton';
import { StatusDot } from '@/components/ui/StatusDot';
import { Tooltip, TooltipShortcut } from '@/components/ui/Tooltip';
import { usePaletteStore } from '@/features/command-palette';
import { ModeSwitcher } from '@/features/composer/components/ModeSwitcher';
import { openThread, threadDisplayName } from '@/features/thread';
import { useGlobalHotkey } from '@/lib/keyboard/shortcuts';
import { runOperation } from '@/lib/report';
import { applyTheme, resolveTheme, watchSystemTheme } from '@/lib/theme/theme';
import {
  useAppStore,
  useContextStatus,
  useSetTheme,
  useSelectedSnapshot,
  useSelectedThread,
  useSelectedWorkspace,
  useToggleRightPanel,
  useToggleSidebar,
  workspaceLabel,
} from '@/store/store';

/** 面包屑:工作区 selector / 会话标题 + 上下文聚合状态点(R2)。 */
export function TopBarLeading() {
  const workspace = useSelectedWorkspace();
  const thread = useSelectedThread();
  const contextStatus = useContextStatus();
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {workspace !== undefined && (
        <>
          <span className="shrink-0 rounded px-1 py-0.5 font-mono text-[12px] text-tertiary">
            {workspaceLabel(workspace)}
          </span>
          <span className="text-disabled">/</span>
        </>
      )}
      <span className="truncate font-medium text-primary">
        {thread === undefined ? 'ello' : threadDisplayName(thread)}
      </span>
      <StatusDot status={contextStatus} size={7} />
    </div>
  );
}

/** 中央状态徽标:模型名 + 会话模式 chip(点击切模式)。 */
export function TopBarCenter() {
  const thread = useSelectedThread();
  const snapshot = useSelectedSnapshot();
  if (thread === undefined || snapshot === undefined) return null;
  return (
    <div className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-2/70 py-1 pr-2 pl-3">
      <span className="max-w-40 truncate text-[12px] text-secondary">
        {snapshot.settings.model}
      </span>
      <span className="h-3 w-px bg-divider" />
      <ModeSwitcher threadId={thread.id} mode={snapshot.settings.mode} />
    </div>
  );
}

/** 全局入口:命令面板 / 主题 / 工作面板显隐。 */
export function TopBarTrailing() {
  const navigate = useNavigate();
  const theme = useAppStore((s) => s.preferences.theme);
  const rightVisible = useAppStore((s) => s.view.rightPanel.visible);
  const setPaletteOpen = usePaletteStore((s) => s.setOpen);
  const setTheme = useSetTheme();
  const toggleRightPanel = useToggleRightPanel();
  const toggleSidebar = useToggleSidebar();

  useGlobalHotkey({ key: 'b', mod: true }, toggleSidebar);
  useGlobalHotkey({ key: 'j', mod: true }, toggleRightPanel);
  useGlobalHotkey({ key: ',', mod: true }, () => void navigate('/settings'));

  const resolved = resolveTheme(theme);

  return (
    <>
      <Tooltip
        content={
          <>
            命令面板 <TooltipShortcut keys="⌘K" />
          </>
        }
      >
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2/60 px-2 text-[12px] text-tertiary transition-colors duration-150 hover:text-primary"
        >
          <Command size={12} />
          <span className="font-mono text-[10px]">⌘K</span>
        </button>
      </Tooltip>
      <IconButton
        icon={resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        tooltip={resolved === 'dark' ? '切换到浅色' : '切换到深色'}
        onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
      />
      <IconButton
        icon={<PanelRight size={15} />}
        tooltip={
          <>
            工作面板 <TooltipShortcut keys="⌘J" />
          </>
        }
        active={rightVisible}
        onClick={toggleRightPanel}
      />
    </>
  );
}

/** 主题副作用:应用 + 跟随系统。挂在 AppProvider。 */
export function useThemeEffect(): void {
  const theme = useAppStore((s) => s.preferences.theme);
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [theme]);
}

/** 选中会话但未加载快照时触发打开。 */
export function useOpenSelectedThreadEffect(): void {
  const threadId = useAppStore((s) => s.view.selectedThreadId);
  const hasSnapshot = useAppStore((s) =>
    s.view.selectedThreadId === null
      ? true
      : s.entities.snapshots[s.view.selectedThreadId] !== undefined,
  );
  const ready = useAppStore((s) => s.connection.phase === 'ready');
  useEffect(() => {
    if (ready && threadId !== null && !hasSnapshot) {
      void runOperation(openThread(threadId));
    }
  }, [ready, threadId, hasSnapshot]);
}
