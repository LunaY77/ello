import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { Tooltip } from './Tooltip';

import { cn } from '@/lib/cn';


/** 固定方形图标按钮;tooltip 必传(可访问名称)。 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly icon: React.ReactNode;
    readonly tooltip: React.ReactNode;
    readonly tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
    readonly size?: 24 | 28 | 32;
    readonly active?: boolean;
  }
>(function IconButton(
  { icon, tooltip, tooltipPlacement, size = 28, active = false, className, ...rest },
  ref,
) {
  return (
    <Tooltip content={tooltip} placement={tooltipPlacement} disabled={rest.disabled}>
      <button
        ref={ref}
        type="button"
        aria-label={typeof tooltip === 'string' ? tooltip : undefined}
        style={{ width: size, height: size }}
        className={cn(
          'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md text-secondary',
          'transition-colors duration-150 ease-(--ease-fluent)',
          'hover:bg-surface-3 hover:text-primary',
          'disabled:cursor-not-allowed disabled:text-disabled disabled:hover:bg-transparent',
          active && 'bg-fluent-subtle text-fluent hover:bg-fluent-subtle hover:text-fluent',
          className,
        )}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
