import type { ReactNode } from 'react';
import { useRef } from 'react';

import { PanelResizer } from './PanelResizer';

import { cn } from '@/lib/cn';
import {
  useAppStore,
  useSetRightPanelVisible,
  useSetRightPanelWidth,
  useSetSidebarWidth,
} from '@/store/store';


const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 380;
const PANEL_MIN = 300;
const PANEL_MAX = 520;
const PANEL_COLLAPSE_BELOW = 260;

/**
 * 应用骨架:Acrylic 顶栏 + 三栏(侧栏 / 时间线 / 工作面板)。
 * 布局组件只读几何与显隐切片,不接触 Server 实体 —— 槽位由 route 组合。
 */
export function AppShell(props: {
  readonly topBar: ReactNode;
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
  readonly rightPanel: ReactNode;
}) {
  const { topBar, sidebar, children, rightPanel } = props;
  const sidebarCollapsed = useAppStore((s) => s.preferences.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.preferences.sidebarWidth);
  const rightPanelWidth = useAppStore((s) => s.preferences.rightPanelWidth);
  const rightVisible = useAppStore((s) => s.view.rightPanel.visible);
  const setRightPanelVisible = useSetRightPanelVisible();
  const setRightPanelWidth = useSetRightPanelWidth();
  const setSidebarWidth = useSetSidebarWidth();

  const sidebarBase = useRef(0);
  const panelBase = useRef(0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {topBar}
      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: sidebarCollapsed ? 48 : sidebarWidth }}
          className={cn(
            'shrink-0 overflow-hidden border-r border-border-subtle bg-sidebar-bg',
            'transition-[width] duration-300 ease-(--ease-fluent)',
          )}
        >
          {sidebar}
        </div>
        {!sidebarCollapsed && (
          <PanelResizer
            side="left"
            currentSize={sidebarWidth}
            onDrag={(delta) => {
              if (sidebarBase.current === 0) sidebarBase.current = sidebarWidth;
              setSidebarWidth(
                Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarBase.current + delta)),
              );
            }}
            onCommit={() => {
              sidebarBase.current = 0;
            }}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-canvas">{children}</main>
        {rightVisible && (
          <>
            <PanelResizer
              side="right"
              currentSize={rightPanelWidth}
              onDrag={(delta) => {
                if (panelBase.current === 0) panelBase.current = rightPanelWidth;
                setRightPanelWidth(
                  Math.min(PANEL_MAX, Math.max(PANEL_MIN, panelBase.current + delta)),
                );
              }}
              onCommit={() => {
                panelBase.current = 0;
              }}
              collapseBelow={PANEL_COLLAPSE_BELOW}
              onCollapse={() => setRightPanelVisible(false)}
            />
            <aside
              style={{ width: rightPanelWidth }}
              className="shrink-0 overflow-hidden border-l border-border-subtle bg-subtle"
            >
              {rightPanel}
            </aside>
          </>
        )}
      </div>
    </div>
  );
}

/** 顶栏框架:56px Acrylic + 窗口控制区留位 + 窗口拖拽区。 */
export function TopBarFrame(props: {
  readonly leading: ReactNode;
  readonly center?: ReactNode;
  readonly trailing: ReactNode;
}) {
  return (
    <header className="acrylic drag-region relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle pr-3 pl-[76px]">
      <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
        {props.leading}
      </div>
      {props.center !== undefined && (
        <div className="no-drag absolute left-1/2 -translate-x-1/2">{props.center}</div>
      )}
      <div className="no-drag flex shrink-0 items-center gap-1">{props.trailing}</div>
    </header>
  );
}

export { PanelResizer };
