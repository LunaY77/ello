import { Folder, FolderPlus, MessageSquarePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useNewThreadPickerStore } from './new-thread-picker-store';
import { startThread } from './thread';

import { runOperation } from '@/lib/report';
import { pickDirectory } from '@/lib/tauri/bridge';
import { appMutations, useAppStore, useWorkspaceRows } from '@/store/store';


const { setLastChatCwd } = appMutations;

/** 在"最近工作区 / 纯聊天"之间选择新会话归属的轻量弹层。 */
export function NewThreadPicker() {
  const open = useNewThreadPickerStore((s) => s.open);
  const setOpen = useNewThreadPickerStore((s) => s.setOpen);
  const workspaceRows = useWorkspaceRows();
  const connected = useAppStore((s) => s.connection.phase === 'ready');
  const [highlight, setHighlight] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const recent = workspaceRows.slice(0, 5);
  const optionCount = recent.length + 1; // + 纯聊天

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  if (!open) return null;

  const close = () => {
    setHighlight(0);
    setOpen(false);
  };

  const startInWorkspace = async (rootPath: string, name: string) => {
    close();
    await runOperation(startThread({ cwd: rootPath, name: `会话 · ${name}` }));
  };

  const startPlainChat = async () => {
    const state = useAppStore.getState();
    let cwd = state.preferences.lastChatCwd;
    if (cwd === null) {
      cwd = await pickDirectory('选择纯聊天的工作目录');
      if (cwd === null) return;
      setLastChatCwd(cwd);
    }
    close();
    await runOperation(startThread({ cwd }));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => (h + 1) % optionCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => (h - 1 + optionCount) % optionCount);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = recent[highlight];
      if (option === undefined) void startPlainChat();
      else void startInWorkspace(option.workspace.rootPath, option.selector);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const highlightClass = (index: number): string =>
    highlight === index ? 'bg-surface-3' : 'hover:bg-surface-2';

  return (
    <div className="fixed inset-0 z-[91]" onClick={close}>
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[1px]" />
      <div
        className="absolute left-1/2 top-28 w-[360px] -translate-x-1/2 overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="border-b border-border-subtle px-3 py-2 text-[12px] text-secondary">
          新建会话到…
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1" role="listbox">
          {recent.map((row, index) => (
            <button
              key={row.workspace.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              tabIndex={-1}
              onClick={() => void startInWorkspace(row.workspace.rootPath, row.selector)}
              className={
                'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-primary ' +
                highlightClass(index)
              }
            >
              <Folder size={14} className="shrink-0 text-fluent" />
              <span className="truncate font-mono text-[12px]">{row.selector}</span>
              <span className="ml-auto text-[10px] text-tertiary">
                {row.threadCount > 0 ? `${row.threadCount} 会话` : '新'}
              </span>
            </button>
          ))}
          <button
            ref={(el) => {
              itemRefs.current[recent.length] = el;
            }}
            type="button"
            tabIndex={-1}
            onClick={() => void startPlainChat()}
            className={
              'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-primary ' +
              highlightClass(recent.length)
            }
          >
            <MessageSquarePlus size={14} className="shrink-0 text-tertiary" />
            纯聊天{recent.length === 0 ? '(选择工作目录)' : ''}
          </button>
        </div>
        <div className="flex items-center gap-1.5 border-t border-border-subtle px-3 py-2 text-[11px] text-tertiary">
          <FolderPlus size={11} />
          需要新工作区?用侧栏"新建任务"创建
          {!connected && <span className="text-warning">(未连接)</span>}
        </div>
      </div>
    </div>
  );
}
