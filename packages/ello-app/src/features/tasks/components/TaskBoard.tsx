import { Check, CircleDashed, ListTodo, LoaderCircle, XCircle } from 'lucide-react';
import { useEffect } from 'react';

import { refreshTasks, setTaskStatus } from '../tasks';

import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { relativeTime } from '@/lib/time';
import { useAppStore } from '@/store/store';
import type { Task } from '@/store/types';


const STATUS_META: Record<
  Task['status'],
  { readonly label: string; readonly icon: typeof CircleDashed; readonly className: string }
> = {
  pending: { label: '待办', icon: CircleDashed, className: 'text-tertiary' },
  inProgress: { label: '进行中', icon: LoaderCircle, className: 'text-fluent' },
  completed: { label: '已完成', icon: Check, className: 'text-success' },
  cancelled: { label: '已取消', icon: XCircle, className: 'text-disabled' },
};

const COLUMN_ORDER: readonly Task['status'][] = [
  'inProgress',
  'pending',
  'completed',
  'cancelled',
];

/** 任务页签:按状态分组,状态灯 + owner + 依赖;操作由 Agent 驱动为主。 */
export function TaskBoard() {
  const tasks = useAppStore((s) => s.entities.tasks);
  const ready = useAppStore((s) => s.connection.phase === 'ready');

  useEffect(() => {
    if (ready) void runOperation(refreshTasks());
  }, [ready]);

  const all = Object.values(tasks).sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );

  if (all.length === 0) {
    return (
      <EmptyState
        icon={<ListTodo size={20} />}
        title="暂无任务"
        description="ello 在拆解工作时会把任务写进任务板,状态实时同步。"
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {COLUMN_ORDER.map((status) => {
        const group = all.filter((task) => task.status === status);
        if (group.length === 0) return null;
        const meta = STATUS_META[status];
        const Icon = meta.icon;
        return (
          <div key={status} className="mb-3">
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <Icon
                size={12}
                className={cn(meta.className, status === 'inProgress' && 'animate-spin-slow')}
              />
              <span className="text-[11px] font-medium text-tertiary">
                {meta.label}
              </span>
              <span className="text-[11px] text-disabled">{group.length}</span>
            </div>
            <div className="flex flex-col gap-1">
              {group.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskCard(props: { readonly task: Task }) {
  const { task } = props;
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[12.5px] leading-5 font-medium text-primary">
          {task.subject}
        </span>
        {task.status !== 'completed' && task.status !== 'cancelled' && (
          <button
            type="button"
            title="标记完成"
            onClick={() => void runOperation(setTaskStatus(task.id, 'completed'))}
            className="mt-0.5 shrink-0 cursor-pointer rounded p-0.5 text-tertiary hover:bg-success-subtle hover:text-success"
          >
            <Check size={13} />
          </button>
        )}
      </div>
      {task.description !== '' && (
        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-tertiary">
          {task.description}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-disabled">
        {task.owner !== null && <span className="font-mono">{task.owner}</span>}
        {task.blockedBy.length > 0 && <span>被 {task.blockedBy.length} 项阻塞</span>}
        <span className="ml-auto">{relativeTime(task.updatedAt)}</span>
      </div>
    </div>
  );
}
