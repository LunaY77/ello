import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

const GAP = 6;

/**
 * 锚定浮层:portal 渲染,Acrylic 材质,Esc / 外部点击关闭。
 * 只承载短内容(菜单、表单 popover),不放在长文本后方。
 */
export function Popover(props: {
  readonly anchor: HTMLElement | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly placement?: PopoverPlacement;
  readonly className?: string;
  readonly width?: number;
}) {
  const { anchor, open, onClose, children, placement = 'bottom-start', className, width } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || anchor === null) return;
    const update = () => {
      const panel = panelRef.current;
      if (panel === null) return;
      const rect = anchor.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const below = placement.startsWith('bottom');
      let top = below
        ? rect.bottom + GAP
        : rect.top - panelRect.height - GAP;
      if (below && top + panelRect.height > window.innerHeight - 8) {
        top = rect.top - panelRect.height - GAP;
      }
      if (!below && top < 8) {
        top = rect.bottom + GAP;
      }
      let left = placement.endsWith('start')
        ? rect.left
        : rect.right - panelRect.width;
      left = Math.max(8, Math.min(left, window.innerWidth - panelRect.width - 8));
      setPosition({ left, top: Math.max(8, top) });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel === null) return;
      if (event.target instanceof Node && !panel.contains(event.target) && !anchor?.contains(event.target)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, anchor, onClose]);

  // 关闭时重置定位:在 render 中同步清理,避免下次打开闪现旧位置。
  if (!open) {
    if (position !== null) setPosition(null);
    return null;
  }
  if (anchor === null) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        width,
        visibility: position === null ? 'hidden' : 'visible',
      }}
      className={cn(
        'acrylic-strong animate-scale-in fixed z-[90] rounded-lg shadow-3',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
