import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

/**
 * 模态对话框:只用于低频、不可逆操作(删除、清空、bypass 确认)。
 * 高频打断一律走 composer 上方常驻队列,不用 Dialog。
 */
export function Dialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly width?: number;
}) {
  const { open, onClose, title, children, footer, width = 440 } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-6">
      <div
        className="animate-fade-in absolute inset-0 bg-overlay"
        onClick={onClose}
      />
      <div
        role="alertdialog"
        aria-label={title}
        style={{ width }}
        className={cn(
          'animate-scale-in relative rounded-xl border border-card-border bg-elevated shadow-3',
        )}
      >
        <div className="px-5 pt-4 pb-1 text-[15px] font-semibold">{title}</div>
        <div className="px-5 py-3 text-[13px] leading-5 text-secondary">{children}</div>
        {footer !== undefined && (
          <div className="flex justify-end gap-2 px-5 pt-1 pb-4">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
