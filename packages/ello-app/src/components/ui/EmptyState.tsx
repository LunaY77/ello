import type { ReactNode } from 'react';

/** 空状态:图标 + 标题 + 一行说明 + 可选主操作。 */
export function EmptyState(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-2 text-tertiary">
        {props.icon}
      </div>
      <div className="text-[14px] font-medium text-primary">{props.title}</div>
      {props.description !== undefined && (
        <div className="max-w-72 text-xs leading-5 text-tertiary">
          {props.description}
        </div>
      )}
      {props.action !== undefined && <div className="mt-2">{props.action}</div>}
    </div>
  );
}
