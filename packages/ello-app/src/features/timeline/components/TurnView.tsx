import type { ThreadItem, Turn } from '@ello/agent/protocol';
import { ChevronRight, Copy, RefreshCw } from 'lucide-react';
import { memo, useState } from 'react';

import { ToolRunGroup, type ToolRunItem } from './ToolRunGroup';

import { Badge } from '@/components/ui/Badge';
import { Markdown } from '@/components/ui/Markdown';
import { toast } from '@/components/ui/Toasts';
import { cn } from '@/lib/cn';


/** 一个回合的完整渲染:用户气泡 + 助手消息 + 工具执行组 + 系统行。 */
export const TurnView = memo(function TurnView(props: {
  readonly turn: Turn;
  readonly isActive: boolean;
}) {
  const { turn, isActive } = props;
  const groups = groupItems(turn.items);
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) =>
        group.kind === 'single' ? (
          <SingleItem key={group.item.id} item={group.item} />
        ) : (
          <ToolRunGroup key={group.items[0]?.id ?? group.startIndex} items={group.items} />
        ),
      )}
      {isActive && turn.items.length === 0 && <ThinkingRow />}
    </div>
  );
});

function ThinkingRow() {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-tertiary">
      <ElloMark active />
      <span className="animate-pulse-soft">思考中…</span>
    </div>
  );
}

type ItemGroup =
  | { readonly kind: 'single'; readonly item: ThreadItem; readonly startIndex: number }
  | { readonly kind: 'toolRun'; readonly items: readonly ToolRunItem[]; readonly startIndex: number };

const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'toolCall', 'subagent']);

/** 连续的工具类 item 折叠为一个执行组;其余 item 独立渲染。 */
function groupItems(items: readonly ThreadItem[]): readonly ItemGroup[] {
  const groups: ItemGroup[] = [];
  let buffer: ToolRunItem[] = [];
  const flush = (index: number) => {
    if (buffer.length === 0) return;
    groups.push({ kind: 'toolRun', items: buffer, startIndex: index - buffer.length });
    buffer = [];
  };
  items.forEach((item, index) => {
    if (TOOL_TYPES.has(item.type)) {
      buffer.push(item as ToolRunItem);
      return;
    }
    flush(index);
    groups.push({ kind: 'single', item, startIndex: index });
  });
  flush(items.length);
  return groups;
}

function SingleItem(props: { readonly item: ThreadItem }) {
  const { item } = props;
  switch (item.type) {
    case 'userMessage':
      return <UserMessage text={item.text} />;
    case 'agentMessage':
      return <AgentMessage text={item.text} streaming={item.status === 'inProgress'} failed={item.status === 'failed'} />;
    case 'reasoning':
      return <ReasoningBlock summary={item.summary} streaming={item.status === 'inProgress'} />;
    case 'plan':
      return <PlanBlock text={item.text} streaming={item.status === 'inProgress'} />;
    case 'contextCompaction':
      return <SystemRow>上下文已压缩({Math.round(item.tokensBefore / 100) / 10}k tokens):{item.summary}</SystemRow>;
    case 'notice':
      return (
        <SystemRow tone={item.level === 'warning' ? 'warning' : 'info'}>
          {item.message}
        </SystemRow>
      );
    case 'error':
      return <SystemRow tone="danger">{item.code}:{item.message}</SystemRow>;
    default:
      return null;
  }
}

function UserMessage(props: { readonly text: string }) {
  return (
    <div className="group/msg relative flex justify-end">
      <div className="max-w-[70%] rounded-xl bg-surface-3 px-4 py-3 text-[13.5px] leading-6 whitespace-pre-wrap text-primary">
        {props.text}
      </div>
      <HoverCopy text={props.text} className="top-1 right-full mr-1" />
    </div>
  );
}

function AgentMessage(props: {
  readonly text: string;
  readonly streaming: boolean;
  readonly failed: boolean;
}) {
  return (
    <div className="group/msg relative flex gap-3">
      <ElloMark active={props.streaming} />
      <div className="min-w-0 flex-1 text-[13.5px] leading-6">
        {props.text === '' && props.streaming ? (
          <span className="animate-pulse-soft text-tertiary">思考中…</span>
        ) : (
          <Markdown text={props.text} streaming={props.streaming} />
        )}
        {props.failed && (
          <div className="mt-1 text-xs text-danger">本条消息生成失败</div>
        )}
      </div>
      {!props.streaming && props.text !== '' && (
        <HoverCopy text={props.text} className="top-0 right-0" />
      )}
    </div>
  );
}

function HoverCopy(props: { readonly text: string; readonly className?: string }) {
  return (
    <button
      type="button"
      aria-label="复制内容"
      onClick={() => {
        void navigator.clipboard.writeText(props.text);
        toast.success('已复制');
      }}
      className={cn(
        'absolute cursor-pointer rounded-md p-1.5 text-tertiary opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 hover:bg-surface-3 hover:text-primary',
        props.className,
      )}
    >
      <Copy size={13} />
    </button>
  );
}

/** ello 状态徽标:24px 渐变圆角方块,执行中微光脉动。 */
export function ElloMark(props: { readonly active?: boolean }) {
  return (
    <div
      className={cn(
        'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[12px] font-bold text-white',
        'bg-gradient-to-br from-[#2b9fff] to-[#005a9e] dark:from-[#60cdff] dark:to-[#106ebe] dark:text-[#0a1a26]',
        props.active === true && 'animate-breathe',
      )}
    >
      e
    </div>
  );
}

function ReasoningBlock(props: { readonly summary: string; readonly streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-[12px] text-tertiary hover:text-secondary"
      >
        <ChevronRight
          size={13}
          className={cn('transition-transform duration-200', open && 'rotate-90')}
        />
        <span className={cn(props.streaming && 'animate-pulse-soft')}>
          {props.streaming ? '正在推理…' : '思考过程'}
        </span>
      </button>
      {open && (
        <div className="border-t border-border-subtle px-3 py-2 text-[12px] leading-5 whitespace-pre-wrap text-tertiary">
          {props.summary}
        </div>
      )}
    </div>
  );
}

function PlanBlock(props: { readonly text: string; readonly streaming: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="overflow-hidden rounded-lg border border-card-border bg-card-bg shadow-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full cursor-pointer items-center gap-2 px-3 text-left"
      >
        <ChevronRight
          size={13}
          className={cn('text-tertiary transition-transform duration-200', open && 'rotate-90')}
        />
        <span className="text-[13px] font-medium text-primary">实施计划</span>
        {props.streaming && <Badge tone="fluent">起草中</Badge>}
      </button>
      {open && (
        <div className="border-t border-card-border px-4 py-3 text-[13px]">
          <Markdown text={props.text} streaming={props.streaming} />
        </div>
      )}
    </div>
  );
}

const SYSTEM_TONE = {
  info: 'text-tertiary',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

/** 系统事件行:模式切换、审批结果、压缩等域事件的居中灰字行。 */
export function SystemRow(props: {
  readonly children: React.ReactNode;
  readonly tone?: keyof typeof SYSTEM_TONE;
}) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-divider" />
      <span className={cn('max-w-[80%] text-center text-[11.5px]', SYSTEM_TONE[props.tone ?? 'info'])}>
        {props.children}
      </span>
      <span className="h-px flex-1 bg-divider" />
    </div>
  );
}

export function RegenerateButton(props: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11px] text-tertiary hover:bg-surface-3 hover:text-primary"
    >
      <RefreshCw size={11} />
      重新生成
    </button>
  );
}
