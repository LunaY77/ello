import type { FileChange } from '@ello/agent/protocol';
import { FileDiff } from 'lucide-react';
import { useMemo } from 'react';


import { DiffView } from '@/components/ui/DiffView';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAppStore } from '@/store/store';

/** 变更页签:当前会话的全部文件变更,按文件聚合,半透明色块 diff。 */
export function ChangesTab() {
  const snapshot = useAppStore((s) => {
    const id = s.view.selectedThreadId;
    return id === null ? undefined : s.entities.snapshots[id];
  });
  const turnDiffs = useAppStore((s) => s.entities.turnDiffs);

  const changes = useMemo(() => {
    if (snapshot === undefined) return [];
    const byPath = new Map<string, FileChange>();
    for (const turn of snapshot.turns) {
      const diff = turnDiffs[turn.id];
      if (diff !== undefined) {
        for (const change of diff) byPath.set(change.path, change);
      }
      for (const item of turn.items) {
        if (item.type === 'fileChange') {
          for (const change of item.changes) byPath.set(change.path, change);
        }
      }
    }
    return [...byPath.values()];
  }, [snapshot, turnDiffs]);

  if (snapshot === undefined || changes.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff size={20} />}
        title="暂无变更"
        description="ello 修改文件后,这里按文件聚合显示完整 diff。"
      />
    );
  }

  const additions = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
  const deletions = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3 font-mono text-[11px] text-tertiary">
        <span>{changes.length} 个文件</span>
        <span className="text-success">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-4">
          {changes.map((change) => (
            <div key={change.path}>
              <div className="mb-1 flex items-center gap-2 font-mono text-[11px]">
                <span className="truncate text-primary">{change.path}</span>
                {change.additions !== undefined && (
                  <span className="shrink-0 text-success">+{change.additions}</span>
                )}
                {change.deletions !== undefined && (
                  <span className="shrink-0 text-danger">−{change.deletions}</span>
                )}
              </div>
              {change.diff !== undefined ? (
                <DiffView diff={change.diff} />
              ) : (
                <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[11px] text-tertiary">
                  {change.kind === 'add' ? '新文件' : change.kind === 'delete' ? '已删除' : '已修改'}(无 diff 内容)
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
