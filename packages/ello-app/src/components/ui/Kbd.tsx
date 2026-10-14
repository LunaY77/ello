import { cn } from '@/lib/cn';
import { formatKeys } from '@/lib/platform';

/** 快捷键标记(kbd 样式),f-sm/tertiary;⌘ 按平台渲染(mac ⌘ / 其他 Ctrl+)。 */
export function Kbd(props: { readonly keys: string; readonly className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 items-center rounded border border-border-subtle bg-surface-2 px-1.5 font-mono text-[10px] text-tertiary',
        props.className,
      )}
    >
      {formatKeys(props.keys)}
    </kbd>
  );
}
