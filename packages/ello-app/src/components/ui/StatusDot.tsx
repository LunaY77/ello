import { cn } from '@/lib/cn';
import type { AggregateStatus } from '@/store/store';

/**
 * 状态点:呼吸蓝 = 运行中,warning = 待审批,danger = 失败,灰 = 空闲。
 * 颜色永远配合形状/动效,不单独依赖颜色。
 */
export function StatusDot(props: {
  readonly status: AggregateStatus;
  readonly size?: number;
}) {
  const { status, size = 8 } = props;
  return (
    <span
      role="img"
      aria-label={`status: ${status}`}
      style={{ width: size, height: size }}
      className={cn(
        'inline-block shrink-0 rounded-full',
        status === 'running' && 'animate-breathe bg-fluent',
        status === 'attention' && 'bg-warning',
        status === 'failed' && 'bg-danger',
        status === 'idle' && 'border border-border-strong bg-transparent',
      )}
    />
  );
}
