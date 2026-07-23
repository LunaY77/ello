import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-fluent text-on-accent shadow-fluent hover:bg-fluent-hover active:bg-fluent-active disabled:bg-surface-3 disabled:text-disabled disabled:shadow-none',
  secondary:
    'bg-surface-2 text-primary border border-border-default hover:bg-surface-3 disabled:text-disabled',
  subtle:
    'text-secondary hover:bg-fluent-subtle hover:text-primary disabled:text-disabled',
  danger:
    'bg-transparent text-danger border border-danger/40 hover:bg-danger-subtle disabled:text-disabled disabled:border-border-default',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3.5 text-[13px] gap-2',
};

/** Fluent button:明确命令用语;图标 + 文字组合由调用方给出。 */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
    readonly icon?: ReactNode;
  }
>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap select-none',
        'transition-colors duration-150 ease-(--ease-fluent)',
        'disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});
