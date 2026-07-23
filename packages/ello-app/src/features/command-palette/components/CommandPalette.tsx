import { Bot, Check, ChevronRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import {
  buildCommands,
  pickModel,
  usePaletteStore,
  type PaletteCommand,
} from '../commands';

import { Kbd } from '@/components/ui/Kbd';
import { StatusDot } from '@/components/ui/StatusDot';
import { openThread, threadDisplayName } from '@/features/thread';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { useAppStore, useThreadRows, type ThreadRow } from '@/store/store';


type Page = { readonly kind: 'root' } | { readonly kind: 'models' };

interface FlatRow {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly icon?: React.ReactNode | undefined;
  readonly shortcut?: string | undefined;
  readonly hint?: string | undefined;
  readonly action: () => void;
}

/** Cmd+K 全局命令入口:Acrylic 浮层,分组命令 + 会话,栈式 drill。 */
export function CommandPalette() {
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const navigate = useNavigate();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(!usePaletteStore.getState().open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  if (!open) return null;
  return (
    <PaletteSurface
      onClose={() => setOpen(false)}
      navigate={navigate}
    />
  );
}

function PaletteSurface(props: {
  readonly onClose: () => void;
  readonly navigate: (path: string) => void;
}) {
  const { onClose, navigate } = props;
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [page, setPage] = useState<Page>({ kind: 'root' });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const threadRows = useThreadRows();
  const models = useAppStore((s) => s.entities.catalogs.models);
  const currentModel = useAppStore((s) => {
    const id = s.view.selectedThreadId;
    return id === null ? null : (s.entities.snapshots[id]?.settings.model ?? null);
  });

  const commands = useMemo(() => buildCommands(navigate), [navigate]);

  const rows: readonly FlatRow[] = useMemo(() => {
    if (page.kind === 'models') {
      return models.map((entry) => ({
        id: entry.id,
        group: '模型',
        label: entry.title ?? entry.name,
        icon:
          entry.id === currentModel ? (
            <Check size={14} className="text-fluent" />
          ) : (
            <Bot size={14} className="text-tertiary" />
          ),
        hint: entry.id === currentModel ? '当前' : undefined,
        action: () => {
          pickModel(entry.id);
          onClose();
        },
      }));
    }
    const q = query.trim().toLowerCase();
    const matchedCommands = commands
      .filter(
        (command) =>
          command.enabled() &&
          (q === '' ||
            command.label.toLowerCase().includes(q) ||
            command.keywords.includes(q)),
      )
      .map((command) =>
        commandRow(command, onClose, () => {
          setPage({ kind: 'models' });
          setHighlight(0);
        }),
      );
    if (q === '') {
      return [
        ...matchedCommands,
        ...threadRows.slice(0, 5).map((row) => threadRow(row, onClose)),
      ];
    }
    return [
      ...matchedCommands,
      ...threadRows
        .filter((row) =>
          threadDisplayName(row.thread).toLowerCase().includes(q),
        )
        .slice(0, 8)
        .map((row) => threadRow(row, onClose)),
    ];
  }, [page, models, currentModel, commands, query, threadRows, onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [page]);

  useEffect(() => {
    const element = listRef.current?.querySelector(`[data-index="${highlight}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  // 分组头在 memo 中预计算,render 不引入可变局部变量。
  const displayRows = useMemo(
    () =>
      rows.map((row, index) => ({
        row,
        showGroup: index === 0 || rows[index - 1]?.group !== row.group,
      })),
    [rows],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((current) => {
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        return (current + direction + rows.length) % Math.max(rows.length, 1);
      });
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      rows[highlight]?.action();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (page.kind !== 'root') {
        setPage({ kind: 'root' });
        setHighlight(0);
      } else onClose();
      return;
    }
    if (event.key === 'Backspace' && query === '' && page.kind !== 'root') {
      event.preventDefault();
      setPage({ kind: 'root' });
      setHighlight(0);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[92]" onClick={onClose}>
      <div className="animate-fade-in absolute inset-0 bg-overlay" />
      <div
        className="acrylic-strong animate-scale-in absolute top-[16%] left-1/2 w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 overflow-hidden rounded-xl shadow-3"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-11 items-center gap-2.5 border-b border-border-subtle px-3.5">
          <Search size={15} className="shrink-0 text-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              page.kind === 'models' ? '选择模型…' : '输入命令或搜索会话…'
            }
            className="h-full w-full bg-transparent text-[14px] text-primary outline-none placeholder:text-disabled"
          />
          {page.kind !== 'root' && <Kbd keys="⌫ 返回" />}
        </div>
        <div ref={listRef} className="max-h-[400px] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-tertiary">
              没有匹配的命令或会话
            </div>
          )}
          {displayRows.map(({ row, showGroup }, index) => {
            return (
              <div key={`${row.group}:${row.id}`}>
                {showGroup && (
                  <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-tertiary first:pt-1">
                    {row.group}
                  </div>
                )}
                <button
                  type="button"
                  data-index={index}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={row.action}
                  className={cn(
                    'relative flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left',
                    index === highlight && 'bg-fluent-subtle',
                  )}
                >
                  {index === highlight && (
                    <span className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-fluent" />
                  )}
                  <span className="inline-flex w-4 shrink-0 justify-center">{row.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-primary">
                    {row.label}
                  </span>
                  {row.hint !== undefined && (
                    <span className="shrink-0 text-[11px] text-tertiary">{row.hint}</span>
                  )}
                  {row.shortcut !== undefined && <Kbd keys={row.shortcut} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function commandRow(
  command: PaletteCommand,
  onClose: () => void,
  drillModels: () => void,
): FlatRow {
  const Icon = command.icon;
  return {
    id: command.id,
    group: '命令',
    label: command.label,
    icon:
      command.drill !== undefined ? (
        <ChevronRight size={14} className="text-tertiary" />
      ) : Icon !== undefined ? (
        <Icon size={14} className="text-tertiary" />
      ) : undefined,
    shortcut: command.shortcut,
    action: () => {
      if (command.drill === 'models') {
        drillModels();
        return;
      }
      onClose();
      command.run();
    },
  };
}

function threadRow(row: ThreadRow, onClose: () => void): FlatRow {
  const status =
    row.thread.status === 'running'
      ? 'running'
      : row.thread.status === 'awaitingApproval' ||
          row.thread.status === 'awaitingUserInput'
        ? 'attention'
        : row.thread.status === 'failed'
          ? 'failed'
          : 'idle';
  return {
    id: row.thread.id,
    group: '会话',
    label: threadDisplayName(row.thread),
    icon: <StatusDot status={status} size={8} />,
    hint: row.workspaceLabel ?? undefined,
    action: () => {
      onClose();
      void runOperation(openThread(row.thread.id));
    },
  };
}
