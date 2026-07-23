import type { ServerRequestParams } from '@ello/agent/protocol';
import {
  ChevronLeft,
  ChevronRight,
  FilePen,
  KeyRound,
  ListChecks,
  MessagesSquare,
  ShieldAlert,
  SquareTerminal,
} from 'lucide-react';
import { useEffect, useState } from 'react';


import { availableDecision, isDangerousCommand, respondApproval } from '../approval';

import { UserInputCard } from './UserInputCard';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { useVisiblePendingRequests } from '@/store/store';
import type { PendingRequestEntry } from '@/store/types';


/**
 * composer 上方常驻审批队列:不是模态,不遮罩时间线。
 * 多条待审批以 1/N 分页,处理完自动切下一条。
 */
export function ApprovalQueue() {
  const pending = useVisiblePendingRequests();
  const [cursor, setCursor] = useState(0);

  // 队列缩短时钳制游标:render 期同步派生。
  const clampedCursor = Math.min(cursor, Math.max(0, pending.length - 1));
  if (cursor !== clampedCursor && pending.length > 0) {
    setCursor(clampedCursor);
  }

  if (pending.length === 0) return null;
  const entry = pending[clampedCursor];
  if (entry === undefined) return null;

  return (
    <div className="animate-slide-up shrink-0 px-4">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 px-1 pb-1.5">
          <ShieldAlert size={12} className="text-warning" />
          <span className="text-[11.5px] font-medium text-warning">需要你的许可</span>
          <div className="flex-1" />
          {pending.length > 1 && (
            <span className="flex items-center gap-1 text-[11px] text-tertiary">
              <button
                type="button"
                aria-label="上一条"
                disabled={clampedCursor === 0}
                onClick={() => setCursor((v) => Math.max(0, v - 1))}
                className="cursor-pointer rounded p-0.5 hover:bg-surface-3 disabled:opacity-40"
              >
                <ChevronLeft size={12} />
              </button>
              {clampedCursor + 1}/{pending.length}
              <button
                type="button"
                aria-label="下一条"
                disabled={clampedCursor >= pending.length - 1}
                onClick={() => setCursor((v) => Math.min(pending.length - 1, v + 1))}
                className="cursor-pointer rounded p-0.5 hover:bg-surface-3 disabled:opacity-40"
              >
                <ChevronRight size={12} />
              </button>
            </span>
          )}
        </div>
        <ApprovalCard key={entry.id} entry={entry} />
      </div>
    </div>
  );
}

function ApprovalCard(props: { readonly entry: PendingRequestEntry }) {
  const { entry } = props;
  if (entry.method === 'item/tool/requestUserInput') {
    return <UserInputCard entry={entry} />;
  }
  return <DecisionCard entry={entry} />;
}

function DecisionCard(props: { readonly entry: PendingRequestEntry }) {
  const { entry } = props;
  const responding = entry.state === 'responding';
  const dangerous =
    entry.method === 'item/commandExecution/requestApproval' &&
    isDangerousCommand(
      (entry.params as ServerRequestParams<'item/commandExecution/requestApproval'>)
        .command,
    );

  const decide = (decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel') =>
    void runOperation(respondApproval(entry.id, decision));

  // 键盘:Y 允许一次 / A 始终允许 / N 拒绝 / Esc 取消。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      const key = event.key.toLowerCase();
      if (key === 'y' && availableDecision(entry, 'accept')) decide('accept');
      if (key === 'a' && availableDecision(entry, 'acceptForSession')) decide('acceptForSession');
      if (key === 'n' && availableDecision(entry, 'decline')) decide('decline');
      if (event.key === 'Escape') decide('cancel');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.state]);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-elevated shadow-3',
        dangerous ? 'border-danger/50' : 'border-card-border',
      )}
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <MethodIcon method={entry.method} />
        <span className="text-[13px] font-semibold text-primary">
          {methodTitle(entry.method)}
        </span>
        {dangerous ? (
          <Badge tone="danger">高风险</Badge>
        ) : (
          <Badge tone="warning">需审批</Badge>
        )}
      </div>

      <div className="flex flex-col gap-1.5 px-4 pb-3">
        <MethodBody entry={entry} dangerous={dangerous} />
        {'reason' in entry.params && entry.params.reason !== '' && (
          <p className="text-[12px] leading-5 text-tertiary">
            为什么:{entry.params.reason}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-2.5">
        <span className="text-[11px] text-disabled">Y 允许 · A 始终 · N 拒绝 · Esc 取消</span>
        <div className="flex-1" />
        {availableDecision(entry, 'decline') && (
          <Button
            variant="danger"
            size="sm"
            disabled={responding}
            onClick={() => decide('decline')}
          >
            拒绝
          </Button>
        )}
        {availableDecision(entry, 'accept') && (
          <Button
            variant="secondary"
            size="sm"
            disabled={responding}
            onClick={() => decide('accept')}
          >
            允许一次
          </Button>
        )}
        {availableDecision(entry, 'acceptForSession') && (
          <Button
            variant={dangerous ? 'secondary' : 'primary'}
            size="sm"
            disabled={responding}
            onClick={() => decide('acceptForSession')}
          >
            始终允许(本次会话)
          </Button>
        )}
      </div>
    </div>
  );
}

function MethodIcon(props: { readonly method: PendingRequestEntry['method'] }) {
  const className = 'text-tertiary';
  switch (props.method) {
    case 'item/commandExecution/requestApproval':
      return <SquareTerminal size={15} className={className} />;
    case 'item/fileChange/requestApproval':
      return <FilePen size={15} className={className} />;
    case 'item/permissions/requestApproval':
      return <KeyRound size={15} className={className} />;
    case 'item/plan/requestApproval':
      return <ListChecks size={15} className={className} />;
    default:
      return <MessagesSquare size={15} className={className} />;
  }
}

function methodTitle(method: PendingRequestEntry['method']): string {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return '运行命令';
    case 'item/fileChange/requestApproval':
      return '修改文件';
    case 'item/permissions/requestApproval':
      return '请求权限';
    case 'item/plan/requestApproval':
      return '实施计划审批';
    case 'item/tool/requestUserInput':
      return '需要你的输入';
  }
}

function MethodBody(props: {
  readonly entry: PendingRequestEntry;
  readonly dangerous: boolean;
}) {
  const { entry } = props;
  switch (entry.method) {
    case 'item/commandExecution/requestApproval': {
      const params = entry.params as ServerRequestParams<'item/commandExecution/requestApproval'>;
      return (
        <>
          <div className="rounded-md border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-[12.5px] text-primary">
            <span className="mr-1.5 text-tertiary select-none">$</span>
            {params.command.join(' ')}
          </div>
          <div className="font-mono text-[11px] text-tertiary">{params.cwd}</div>
        </>
      );
    }
    case 'item/fileChange/requestApproval': {
      const params = entry.params as ServerRequestParams<'item/fileChange/requestApproval'>;
      return (
        <>
          <p className="text-[12.5px] text-primary">{params.summary}</p>
          <div className="flex flex-wrap gap-1">
            {params.paths.map((path) => (
              <span
                key={path}
                className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-secondary"
              >
                {path}
              </span>
            ))}
          </div>
        </>
      );
    }
    case 'item/permissions/requestApproval': {
      const params = entry.params as ServerRequestParams<'item/permissions/requestApproval'>;
      return (
        <p className="text-[12.5px] text-primary">
          权限 <code className="font-mono text-fluent">{params.permission}</code>,作用域{' '}
          {params.scope}
        </p>
      );
    }
    case 'item/plan/requestApproval': {
      const params = entry.params as ServerRequestParams<'item/plan/requestApproval'>;
      return (
        <pre className="max-h-40 overflow-auto rounded-md border border-border-subtle bg-surface-2 p-3 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-secondary">
          {params.preview}
        </pre>
      );
    }
    case 'item/tool/requestUserInput':
      return null;
  }
}
