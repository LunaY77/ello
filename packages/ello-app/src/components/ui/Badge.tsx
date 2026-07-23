import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'fluent' | 'success' | 'warning' | 'danger';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-3 text-secondary',
  fluent: 'bg-fluent-subtle text-fluent',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
};

/** 小型 pill 徽标:风险等级、模式、计数。 */
export function Badge(props: {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly className?: string;
}) {
  const { children, tone = 'neutral', className } = props;
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-none font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
