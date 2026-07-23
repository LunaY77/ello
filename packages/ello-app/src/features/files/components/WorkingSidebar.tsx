import { FileDiff, FolderTree, ListTodo, X } from 'lucide-react';

import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';

import { IconButton } from '@/components/ui/IconButton';
import { TaskBoard } from '@/features/tasks';
import { cn } from '@/lib/cn';
import {
  useAppStore,
  useSetRightPanelTab,
  useSetRightPanelVisible,
} from '@/store/store';
import type { RightPanelTab } from '@/store/types';


const TABS: ReadonlyArray<{
  readonly id: RightPanelTab;
  readonly label: string;
  readonly icon: typeof FolderTree;
}> = [
  { id: 'files', label: '文件', icon: FolderTree },
  { id: 'changes', label: '变更', icon: FileDiff },
  { id: 'tasks', label: '任务', icon: ListTodo },
];

/** 右侧工作面板:文件 / 变更 / 任务 三页签,跟随工作区上下文切换。 */
export function WorkingSidebar() {
  const tab = useAppStore((s) => s.view.rightPanel.tab);
  const setRightPanelTab = useSetRightPanelTab();
  const setRightPanelVisible = useSetRightPanelVisible();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border-subtle px-2">
        {TABS.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setRightPanelTab(entry.id)}
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors duration-150',
                tab === entry.id
                  ? 'bg-fluent-subtle font-medium text-fluent'
                  : 'text-secondary hover:bg-surface-3 hover:text-primary',
              )}
            >
              <Icon size={13} />
              {entry.label}
            </button>
          );
        })}
        <div className="flex-1" />
        <IconButton
          icon={<X size={14} />}
          tooltip="关闭面板 (⌘J)"
          size={24}
          onClick={() => setRightPanelVisible(false)}
        />
      </div>
      {tab === 'files' && <FilesTab />}
      {tab === 'changes' && <ChangesTab />}
      {tab === 'tasks' && <TaskBoard />}
    </div>
  );
}
