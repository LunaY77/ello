import type {
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  SubagentItemSchema,
  ToolCallItemSchema,
} from '@ello/agent/protocol';
import {
  Bot,
  Check,
  ChevronRight,
  CircleSlash,
  FilePen,
  LoaderCircle,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { z } from 'zod';

import { DiffView } from '@/components/ui/DiffView';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';

export type ToolRunItem =
  | z.output<typeof CommandExecutionItemSchema>
  | z.output<typeof FileChangeItemSchema>
  | z.output<typeof ToolCallItemSchema>
  | z.output<typeof SubagentItemSchema>;

/**
 * RunSummary 胶囊:时间线只放结论(步骤数 / 耗时 / 成败),
 * 细节就地展开为步骤表。二级深入(Tool Inspector)由右栏承担。
 */
export const ToolRunGroup = memo(function ToolRunGroup(props: {
  readonly items: readonly ToolRunItem[];
}) {
  const { items } = props;
  const [expanded, setExpanded] = useState(false);

  const summary = useMemo(() => {
    const running = items.some((item) => item.status === 'inProgress');
    const failed = items.filter((item) => item.status === 'failed').length;
    const declined = items.filter((item) => item.status === 'declined').length;
    const durationMs = items.reduce(
      (total, item) =>
        total + (item.type === 'commandExecution' ? (item.durationMs ?? 0) : 0),
      0,
    );
    const files = new Set(
      items.flatMap((item) =>
        item.type === 'fileChange' ? item.changes.map((change) => change.path) : [],
      ),
    );
    return { running, failed, declined, durationMs, fileCount: files.size };
  }, [items]);

  const tone = summary.running
    ? 'text-fluent'
    : summary.failed > 0
      ? 'text-danger'
      : 'text-success';

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border-subtle bg-surface-2 pr-3 pl-2.5',
          'transition-colors duration-150 hover:border-border-default hover:bg-surface-3',
        )}
      >
        {summary.running ? (
          <LoaderCircle size={13} className={cn('animate-spin-slow', tone)} />
        ) : summary.failed > 0 ? (
          <X size={13} className={tone} />
        ) : (
          <Check size={13} className={tone} />
        )}
        <span className="text-[12px] text-secondary">
          {summary.running ? '执行中' : '已执行'} {items.length} 个步骤
          {summary.durationMs > 0 && ` · ${formatDuration(summary.durationMs)}`}
          {summary.fileCount > 0 && ` · 修改 ${summary.fileCount} 个文件`}
          {summary.failed > 0 && ` · ${summary.failed} 失败`}
          {summary.declined > 0 && ` · ${summary.declined} 已拒绝`}
        </span>
        <ChevronRight
          size={13}
          className={cn(
            'text-tertiary transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div className="animate-fade-in flex w-full flex-col gap-1.5 pl-1">
          {items.map((item, index) => (
            <StepRow key={item.id} item={item} index={index + 1} />
          ))}
        </div>
      )}
    </div>
  );
});

function StepRow(props: { readonly item: ToolRunItem; readonly index: number }) {
  const { item, index } = props;
  const [open, setOpen] = useState(false);
  const failed = item.status === 'failed';
  const running = item.status === 'inProgress';

  return (
    <div
      className={cn(
        'relative w-full rounded-lg border border-border-subtle bg-surface-1',
        failed && 'border-l-2 border-l-danger',
      )}
    >
      {running && (
        <span className="absolute top-3 left-1.5 h-1.5 w-1.5 animate-breathe rounded-full bg-fluent" />
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className="w-5 shrink-0 font-mono text-[11px] text-disabled">#{index}</span>
        <StepIcon item={item} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-primary">
          {stepTitle(item)}
        </span>
        <StepStatus item={item} />
        <ChevronRight
          size={12}
          className={cn('shrink-0 text-tertiary transition-transform duration-200', open && 'rotate-90')}
        />
      </button>
      {open && <StepDetail item={item} />}
    </div>
  );
}

function StepIcon(props: { readonly item: ToolRunItem }) {
  const className = 'shrink-0 text-tertiary';
  switch (props.item.type) {
    case 'commandExecution':
      return <SquareTerminal size={13} className={className} />;
    case 'fileChange':
      return <FilePen size={13} className={className} />;
    case 'subagent':
      return <Bot size={13} className={className} />;
    case 'toolCall':
      return <Wrench size={13} className={className} />;
  }
}

function stepTitle(item: ToolRunItem): string {
  switch (item.type) {
    case 'commandExecution':
      return item.command;
    case 'fileChange': {
      const first = item.changes[0];
      if (first === undefined) return '文件变更';
      return item.changes.length === 1
        ? `编辑 ${first.path}`
        : `编辑 ${first.path} 等 ${item.changes.length} 个文件`;
    }
    case 'toolCall':
      return item.headline === '' ? item.toolName : item.headline;
    case 'subagent':
      return item.description === '' ? item.agentName : item.description;
  }
}

function StepStatus(props: { readonly item: ToolRunItem }) {
  const { item } = props;
  if (item.status === 'inProgress') {
    return <LoaderCircle size={12} className="shrink-0 animate-spin-slow text-fluent" />;
  }
  if (item.status === 'failed') {
    return <X size={12} className="shrink-0 text-danger" />;
  }
  if (item.status === 'declined') {
    return <CircleSlash size={12} className="shrink-0 text-warning" />;
  }
  if (item.type === 'commandExecution' && item.durationMs !== undefined) {
    return (
      <span className="shrink-0 font-mono text-[11px] text-tertiary">
        {formatDuration(item.durationMs)}
      </span>
    );
  }
  return <Check size={12} className="shrink-0 text-success" />;
}

function StepDetail(props: { readonly item: ToolRunItem }) {
  const { item } = props;
  switch (item.type) {
    case 'commandExecution':
      return <CommandDetail item={item} />;
    case 'fileChange':
      return <FileChangeDetail item={item} />;
    case 'toolCall':
      return item.outputPreview === undefined ? null : (
        <DetailShell>
          <MonoBlock text={item.outputPreview} />
        </DetailShell>
      );
    case 'subagent':
      return item.output === undefined ? null : (
        <DetailShell>
          <MonoBlock text={item.output} />
        </DetailShell>
      );
  }
}

function DetailShell(props: { readonly children: React.ReactNode }) {
  return (
    <div className="border-t border-border-subtle px-3 py-2">{props.children}</div>
  );
}

function MonoBlock(props: { readonly text: string; readonly maxLines?: number }) {
  const lines = props.text.split('\n');
  const max = props.maxLines ?? 20;
  const visible = lines.slice(0, max);
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-surface-2 p-2.5 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-secondary">
      {visible.join('\n')}
      {lines.length > max && `\n… 还有 ${lines.length - max} 行`}
    </pre>
  );
}

/** 三段式命令卡:sticky 顶栏(命令)→ 输出 → 底栏(exit + 耗时)。 */
function CommandDetail(props: {
  readonly item: z.output<typeof CommandExecutionItemSchema>;
}) {
  const { item } = props;
  return (
    <div className="border-t border-border-subtle">
      <div className="border-b border-border-subtle bg-surface-2 px-3 py-1.5 font-mono text-[11.5px] text-primary">
        <span className="mr-1.5 text-tertiary select-none">$</span>
        {item.command}
      </div>
      {item.outputPreview !== undefined && item.outputPreview !== '' && (
        <div className="max-h-72 overflow-auto px-3 py-2">
          <pre className="font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-secondary">
            {item.outputPreview}
          </pre>
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 font-mono text-[11px] text-tertiary">
        {item.exitCode !== undefined && (
          <span className={item.exitCode === 0 ? 'text-success' : 'text-danger'}>
            exit {item.exitCode}
          </span>
        )}
        {item.durationMs !== undefined && <span>{formatDuration(item.durationMs)}</span>}
        {item.outputBytes !== undefined && <span>{item.outputBytes} bytes</span>}
      </div>
    </div>
  );
}

function FileChangeDetail(props: {
  readonly item: z.output<typeof FileChangeItemSchema>;
}) {
  const { item } = props;
  return (
    <div className="flex flex-col gap-2 border-t border-border-subtle px-3 py-2">
      {item.changes.map((change) => (
        <div key={change.path}>
          <div className="mb-1 flex items-center gap-2 font-mono text-[11px]">
            <span className="text-primary">{change.path}</span>
            {change.additions !== undefined && (
              <span className="text-success">+{change.additions}</span>
            )}
            {change.deletions !== undefined && (
              <span className="text-danger">−{change.deletions}</span>
            )}
            <span className="text-tertiary">{change.kind}</span>
          </div>
          {change.diff !== undefined && (
            <DiffView diff={change.diff} maxLines={60} />
          )}
        </div>
      ))}
    </div>
  );
}
