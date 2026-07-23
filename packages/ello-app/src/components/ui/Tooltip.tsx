import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type Placement = 'top' | 'bottom' | 'left' | 'right';

const OFFSET = 6;
const DELAY_MS = 350;

/** 轻量 tooltip:portal 渲染避免裁剪,hover 延迟 350ms,focus 立现。 */
export function Tooltip(props: {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly placement?: Placement | undefined;
  readonly disabled?: boolean | undefined;
}) {
  const { content, children, placement = 'top', disabled = false } = props;
  const [anchorEl, setAnchorEl] = useState<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback((immediate: boolean) => {
    clearTimeout(timerRef.current);
    if (immediate) {
      setVisible(true);
      return;
    }
    timerRef.current = setTimeout(() => setVisible(true), DELAY_MS);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  if (disabled) return <>{children}</>;

  return (
    <>
      <span
        ref={setAnchorEl}
        className="inline-flex"
        onMouseEnter={() => show(false)}
        onMouseLeave={hide}
        onFocus={() => show(true)}
        onBlur={hide}
      >
        {children}
      </span>
      {visible && anchorEl !== null && (
        <TooltipBubble
          anchor={anchorEl.getBoundingClientRect()}
          placement={placement}
          content={content}
        />
      )}
    </>
  );
}

function TooltipBubble(props: {
  readonly anchor: DOMRect;
  readonly placement: Placement;
  readonly content: ReactNode;
}) {
  const { anchor, placement, content } = props;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );

  useEffect(() => {
    const bubble = bubbleRef.current;
    if (bubble === null) return;
    const rect = bubble.getBoundingClientRect();
    let left = anchor.left + anchor.width / 2 - rect.width / 2;
    let top = anchor.top - rect.height - OFFSET;
    let resolved = placement;
    if (resolved === 'top' && top < 4) resolved = 'bottom';
    if (resolved === 'bottom') top = anchor.bottom + OFFSET;
    if (resolved === 'top') top = anchor.top - rect.height - OFFSET;
    if (resolved === 'left') {
      left = anchor.left - rect.width - OFFSET;
      top = anchor.top + anchor.height / 2 - rect.height / 2;
    }
    if (resolved === 'right') {
      left = anchor.right + OFFSET;
      top = anchor.top + anchor.height / 2 - rect.height / 2;
    }
    left = Math.max(4, Math.min(left, window.innerWidth - rect.width - 4));
    setPosition({ left, top });
  }, [anchor, placement]);

  return createPortal(
    <div
      ref={bubbleRef}
      role="tooltip"
      style={{
        left: position?.left ?? anchor.left,
        top: position?.top ?? anchor.top,
        visibility: position === null ? 'hidden' : 'visible',
      }}
      className="acrylic-strong animate-fade-in pointer-events-none fixed z-[100] max-w-64 rounded-md px-2 py-1 text-[11px] leading-4 text-secondary shadow-2"
    >
      {content}
    </div>,
    document.body,
  );
}

/** tooltip 内的快捷键标注。 */
export function TooltipShortcut(props: { readonly keys: string }) {
  return <span className="ml-2 font-mono text-tertiary">{props.keys}</span>;
}
