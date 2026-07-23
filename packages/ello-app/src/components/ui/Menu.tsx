import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Popover, type PopoverPlacement } from './Popover';

import { cn } from '@/lib/cn';


export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode | undefined;
  readonly shortcut?: string | undefined;
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly hint?: string | undefined;
}

/**
 * 触发器 + 锚定菜单。菜单行 36px,键盘 ↑/↓ 移动、Enter 执行;
 * hover 与键盘选中态互相同步。
 */
export function Menu(props: {
  readonly trigger: (props: {
    readonly open: boolean;
    readonly toggle: () => void;
    readonly ref: (node: HTMLElement | null) => void;
  }) => ReactNode;
  readonly items: readonly MenuItem[];
  readonly onSelect: (id: string) => void;
  readonly placement?: PopoverPlacement;
  readonly width?: number;
  readonly header?: ReactNode;
}) {
  const { trigger, items, onSelect, placement = 'bottom-start', width = 220, header } = props;
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时重置高亮:在 render 中同步派生,不开额外 render 周期。
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setHighlight(0);
  }

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight((current) => {
          let next = current;
          for (let step = 0; step < items.length; step += 1) {
            next = (next + direction + items.length) % items.length;
            if (items[next]?.disabled !== true) break;
          }
          return next;
        });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[highlight];
        if (item !== undefined && !item.disabled) {
          setOpen(false);
          onSelect(item.id);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, items, highlight, onSelect]);

  useEffect(() => {
    const list = listRef.current;
    const element = list?.querySelector(`[data-index="${highlight}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  return (
    <>
      {trigger({
        open,
        toggle: () => setOpen((current) => !current),
        ref: setAnchorEl,
      })}
      <Popover
        anchor={anchorEl}
        open={open}
        onClose={() => setOpen(false)}
        placement={placement}
        width={width}
      >
        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {header}
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              data-index={index}
              disabled={item.disabled}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => {
                setOpen(false);
                onSelect(item.id);
              }}
              className={cn(
                'flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px]',
                'transition-colors duration-150',
                index === highlight && 'bg-fluent-subtle',
                item.danger ? 'text-danger' : 'text-primary',
                item.disabled && 'cursor-not-allowed text-disabled',
              )}
            >
              {item.icon !== undefined && (
                <span className="inline-flex w-4 shrink-0 justify-center text-tertiary">
                  {item.icon}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint !== undefined && (
                <span className="shrink-0 text-xs text-tertiary">{item.hint}</span>
              )}
              {item.shortcut !== undefined && (
                <kbd className="shrink-0 rounded border border-border-subtle bg-surface-2 px-1 text-[10px] leading-4 text-tertiary">
                  {item.shortcut}
                </kbd>
              )}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
