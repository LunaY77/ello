import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { create } from 'zustand';

import { cn } from '@/lib/cn';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string;
  readonly description?: string | undefined;
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
  readonly durationMs: number;
}

interface ToastState {
  readonly toasts: readonly ToastItem[];
  push: (
    toast: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number | undefined },
  ) => number;
  dismiss: (id: number) => void;
}

let nextToastId = 1;

const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextToastId;
    nextToastId += 1;
    const item: ToastItem = { ...toast, id, durationMs: toast.durationMs ?? 5000 };
    set((state) => ({ toasts: [...state.toasts.slice(-4), item] }));
    return id;
  },
  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export const toast = {
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ tone: 'info', title, description }),
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ tone: 'success', title, description }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ tone: 'warning', title, description }),
  danger: (title: string, description?: string) =>
    useToastStore.getState().push({ tone: 'danger', title, description, durationMs: 8000 }),
  action: (
    title: string,
    action: { readonly label: string; readonly onClick: () => void },
    durationMs = 5000,
  ) => useToastStore.getState().push({ tone: 'info', title, action, durationMs }),
  dismiss: (id: number) => useToastStore.getState().dismiss(id),
  clear: () => useToastStore.setState({ toasts: [] }),
};

const TONE_ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'text-fluent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** Toast 宿主:右下角堆叠,最长 5 条。 */
export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[96] flex w-80 flex-col gap-2">
      {toasts.map((item) => (
        <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

function ToastCard(props: { readonly item: ToastItem; readonly onDismiss: () => void }) {
  const { item, onDismiss } = props;
  const Icon = TONE_ICON[item.tone];

  useEffect(() => {
    const timer = setTimeout(onDismiss, item.durationMs);
    return () => clearTimeout(timer);
  }, [item.durationMs, onDismiss]);

  return (
    <div className="acrylic-strong animate-slide-up pointer-events-auto flex items-start gap-2.5 rounded-lg p-3 shadow-3">
      <Icon size={16} className={cn('mt-0.5 shrink-0', TONE_CLASS[item.tone])} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-5 font-medium text-primary">{item.title}</div>
        {item.description !== undefined && (
          <div className="mt-0.5 line-clamp-2 text-xs leading-4 text-tertiary">
            {item.description}
          </div>
        )}
        {item.action !== undefined && (
          <button
            type="button"
            className="mt-1 cursor-pointer text-xs font-medium text-fluent hover:underline"
            onClick={() => {
              item.action?.onClick();
              onDismiss();
            }}
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="关闭通知"
        className="cursor-pointer rounded p-0.5 text-tertiary hover:bg-surface-3 hover:text-primary"
        onClick={onDismiss}
      >
        <X size={12} />
      </button>
    </div>
  );
}
