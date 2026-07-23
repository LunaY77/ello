import type { SessionMode } from '@ello/agent/protocol';
import { ChevronDown, ShieldAlert, ShieldCheck, Eye, Zap } from 'lucide-react';
import { useState } from 'react';


import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { setThreadMode } from '@/features/thread';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';

export const MODE_META: Record<
  SessionMode,
  { readonly label: string; readonly hint: string; readonly icon: typeof Eye }
> = {
  'ask-before-changes': {
    label: 'ask-before-changes',
    hint: '每次改动前都请求许可',
    icon: ShieldCheck,
  },
  'accept-edits': {
    label: 'accept-edits',
    hint: '自动接受文件编辑,命令仍需审批',
    icon: Zap,
  },
  plan: {
    label: 'plan',
    hint: '先出实施计划,批准后才动手',
    icon: Eye,
  },
  bypass: {
    label: 'bypass',
    hint: '全部自动执行,不再请求许可',
    icon: ShieldAlert,
  },
};

/** 会话模式切换器(ControlBar);bypass 需二次确认 —— 唯一允许的确认弹窗。 */
export function ModeSwitcher(props: {
  readonly threadId: string;
  readonly mode: SessionMode;
  readonly disabled?: boolean;
}) {
  const { threadId, mode, disabled = false } = props;
  const [confirmBypass, setConfirmBypass] = useState(false);
  const meta = MODE_META[mode];
  const Icon = meta.icon;

  const items: readonly MenuItem[] = (
    Object.keys(MODE_META) as readonly SessionMode[]
  ).map((candidate) => {
    const entry = MODE_META[candidate];
    const ItemIcon = entry.icon;
    return {
      id: candidate,
      label: entry.label,
      hint: entry.hint,
      icon: <ItemIcon size={14} />,
      danger: candidate === 'bypass',
    };
  });

  return (
    <>
      <Menu
        placement="top-start"
        width={300}
        trigger={({ toggle, ref, open }) => (
          <button
            ref={ref as React.Ref<HTMLButtonElement>}
            type="button"
            disabled={disabled}
            onClick={toggle}
            className={cn(
              'flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 font-mono text-[11px] transition-colors duration-150',
              mode === 'bypass'
                ? 'border border-warning/50 text-warning'
                : 'text-tertiary hover:bg-surface-3 hover:text-primary',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <Icon size={11} />
            {meta.label}
            <ChevronDown
              size={10}
              className={cn('transition-transform duration-200', open && 'rotate-180')}
            />
          </button>
        )}
        items={items}
        onSelect={(id) => {
          const next = id as SessionMode;
          if (next === mode) return;
          if (next === 'bypass') {
            setConfirmBypass(true);
            return;
          }
          void runOperation(setThreadMode(threadId, next));
        }}
      />
      <Dialog
        open={confirmBypass}
        onClose={() => setConfirmBypass(false)}
        title="启用 bypass 模式"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmBypass(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmBypass(false);
                void runOperation(setThreadMode(threadId, 'bypass'));
              }}
            >
              启用 bypass
            </Button>
          </>
        }
      >
        bypass 模式下 ello 将自动执行所有命令与文件修改,不再请求你的许可。
        仅在你完全信任当前任务时启用。
      </Dialog>
    </>
  );
}
