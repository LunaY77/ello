import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

/**
 * 栏缘拖拽把手:5px 命中区,hover 显示 2px fluent 指示条;
 * 拖拽中实时回调,松开后由调用方持久化。低于 collapseBelow 触发自动收起。
 */
export function PanelResizer(props: {
  readonly side: 'left' | 'right';
  readonly onDrag: (delta: number) => void;
  readonly onCommit: () => void;
  readonly onCollapse?: () => void;
  readonly collapseBelow?: number;
  readonly currentSize: number;
}) {
  const { side, onDrag, onCommit, onCollapse, collapseBelow, currentSize } = props;
  const [dragging, setDragging] = useState(false);
  const startRef = useRef(0);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      startRef.current = event.clientX;
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (!dragging) return;
        const raw = event.clientX - startRef.current;
        const delta = side === 'left' ? raw : -raw;
        if (
          collapseBelow !== undefined &&
          onCollapse !== undefined &&
          currentSize + delta < collapseBelow
        ) {
          setDragging(false);
          onCollapse();
          return;
        }
        onDrag(delta);
      }}
      onPointerUp={() => {
        if (!dragging) return;
        setDragging(false);
        startRef.current = 0;
        onCommit();
      }}
      className={cn(
        'group relative z-20 -mx-[2px] w-[5px] shrink-0 cursor-col-resize',
        side === 'left' ? 'order-first' : '',
      )}
    >
      <div
        className={cn(
          'absolute inset-y-0 left-[2px] w-[2px] rounded-full transition-colors duration-150',
          dragging ? 'bg-fluent' : 'bg-transparent group-hover:bg-fluent/60',
        )}
      />
    </div>
  );
}
