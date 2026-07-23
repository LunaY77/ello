import { cn } from '@/lib/cn';

/** 快捷键标注(kbd 样式),f-sm/tertiary。 */
export function Kbd(props: { readonly keys: string; readonly className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 items-center rounded border border-border-subtle bg-surface-2 px-1.5 font-mono text-[10px] text-tertiary',
        props.className,
      )}
    >
      {props.keys}
    </kbd>
  );
}
