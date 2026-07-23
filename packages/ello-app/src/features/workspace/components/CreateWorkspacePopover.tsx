import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { createWorkspace, refreshRepos } from '../workspace';

import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { toast } from '@/components/ui/Toasts';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { useAppStore } from '@/store/store';
import type { WorkspaceKind } from '@/store/types';

const KINDS: ReadonlyArray<{ readonly kind: WorkspaceKind; readonly label: string; readonly hint: string }> = [
  { kind: 'feature', label: 'feature', hint: '新功能开发' },
  { kind: 'fix', label: 'fix', hint: '问题修复' },
  { kind: 'refactor', label: 'refactor', hint: '重构' },
  { kind: 'explore', label: 'explore', hint: '技术调研' },
];

/** 创建 Workspace 的 popover 表单:kind + name(slug 预览)+ 仓库勾选。 */
export function CreateWorkspacePopover(props: {
  readonly trigger: ReactNode;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { trigger, open, onOpenChange } = props;
  const [anchorEl, setAnchorEl] = useState<HTMLDivElement | null>(null);
  const [kind, setKind] = useState<WorkspaceKind>('feature');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const repos = useAppStore((s) => s.entities.repos);
  const ready = useAppStore((s) => s.connection.phase === 'ready');

  // 关闭时清空勾选:下次打开重新选择。
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) setSelected(new Set());
  }

  // 注册表经 store 消费;打开时若为空则刷新(未连接就绪不发 RPC)。
  useEffect(() => {
    if (open && ready && repos.length === 0) {
      void runOperation(refreshRepos());
    }
  }, [open, ready, repos.length]);

  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const canSubmit = slug !== '' && selected.size > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true);
    try {
      await runOperation(
        createWorkspace({ kind, name: slug, repos: [...selected] }),
      );
    } finally {
      setSubmitting(false);
    }
    toast.success('工作区已创建', `${kind}/${slug}`);
    setName('');
    onOpenChange(false);
  };

  return (
    <>
      <div ref={setAnchorEl}>{trigger}</div>
      <Popover
        anchor={anchorEl}
        open={open}
        onClose={() => onOpenChange(false)}
        placement="bottom-start"
        width={300}
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="text-[13px] font-semibold text-primary">新建任务</div>

          <div className="flex gap-1">
            {KINDS.map((entry) => (
              <button
                key={entry.kind}
                type="button"
                title={entry.hint}
                onClick={() => setKind(entry.kind)}
                className={cn(
                  'h-7 flex-1 cursor-pointer rounded-md border font-mono text-[11px] transition-colors duration-150',
                  kind === entry.kind
                    ? 'border-card-border-accent bg-fluent-subtle text-fluent'
                    : 'border-border-subtle text-secondary hover:bg-surface-2',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="任务名称,如 search-page"
              autoFocus
              className="h-8 w-full rounded-md border border-border-default bg-surface-1 px-2.5 text-[13px] text-primary outline-none placeholder:text-disabled focus:border-card-border-accent"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) void submit();
              }}
            />
            <div className="mt-1 flex items-center gap-1 font-mono text-[11px] text-tertiary">
              <ChevronDown size={10} className="-rotate-90" />
              {kind}/{slug === '' ? '…' : slug}
            </div>
          </div>

          <div>
            <div className="mb-1 text-[11px] text-tertiary">关联仓库(至少一个)</div>
            <div className="max-h-36 overflow-y-auto rounded-md border border-border-subtle">
              {repos.length === 0 && (
                <div className="px-3 py-2 text-[11px] leading-4 text-tertiary">
                  {ready ? '仓库注册表为空。请先在 ello 中注册仓库(repo/add)。' : '未连接到 ello-agent。'}
                </div>
              )}
              {repos.map((repo) => {
                const checked = selected.has(repo.key);
                return (
                  <button
                    key={repo.key}
                    type="button"
                    onClick={() => {
                      const next = new Set(selected);
                      if (checked) next.delete(repo.key);
                      else next.add(repo.key);
                      setSelected(next);
                    }}
                    className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left font-mono text-[12px] text-primary hover:bg-surface-2"
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border',
                        checked
                          ? 'border-fluent bg-fluent text-on-accent'
                          : 'border-border-strong',
                      )}
                    >
                      {checked && <Check size={10} />}
                    </span>
                    {repo.key}
                  </button>
                );
              })}
            </div>
          </div>

          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitting ? '创建中…' : '创建并打开'}
          </Button>
        </div>
      </Popover>
    </>
  );
}
