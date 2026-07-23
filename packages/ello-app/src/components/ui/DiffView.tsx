import { useMemo } from 'react';

import { cn } from '@/lib/cn';

/**
 * unified diff 渲染:半透明色块行 + 行号 gutter + hunk 分隔。
 * 只解析标准 unified diff;解析失败直接抛错,不静默降级成纯文本。
 */
export interface DiffLine {
  readonly kind: 'add' | 'remove' | 'context' | 'hunk' | 'meta';
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export function parseUnifiedDiff(diff: string): readonly DiffLine[] {
  const lines = diff.split('\n');
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match === null) {
        throw new Error(`Malformed diff hunk header: ${raw}`);
      }
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      result.push({ kind: 'hunk', content: raw, oldLine: null, newLine: null });
      continue;
    }
    if (
      raw.startsWith('diff ') ||
      raw.startsWith('index ') ||
      raw.startsWith('---') ||
      raw.startsWith('+++') ||
      raw.startsWith('new file') ||
      raw.startsWith('deleted file') ||
      raw.startsWith('rename') ||
      raw.startsWith('similarity') ||
      raw.startsWith('Binary')
    ) {
      result.push({ kind: 'meta', content: raw, oldLine: null, newLine: null });
      continue;
    }
    if (raw.startsWith('+')) {
      result.push({ kind: 'add', content: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      result.push({ kind: 'remove', content: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (raw.startsWith('\\')) {
      result.push({ kind: 'meta', content: raw, oldLine: null, newLine: null });
      continue;
    }
    const content = raw.startsWith(' ') ? raw.slice(1) : raw;
    result.push({ kind: 'context', content, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return result;
}

const ROW_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-(--diff-add-bg)',
  remove: 'bg-(--diff-remove-bg)',
  context: '',
  hunk: 'bg-(--diff-hunk-bg) text-tertiary',
  meta: 'text-tertiary',
};

const GUTTER_CLASS: Record<DiffLine['kind'], string> = {
  add: 'text-success',
  remove: 'text-danger',
  context: 'text-disabled',
  hunk: 'text-disabled',
  meta: 'text-disabled',
};

export function DiffView(props: {
  readonly diff: string;
  readonly maxLines?: number;
  readonly className?: string;
}) {
  const { diff, maxLines, className } = props;
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const visible = maxLines === undefined ? lines : lines.slice(0, maxLines);
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-lg border border-border-subtle bg-surface-2 font-mono text-[11.5px] leading-[1.55]',
        className,
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {visible.map((line, index) => (
            <tr key={index} className={ROW_CLASS[line.kind]}>
              <td
                className={cn(
                  'w-10 min-w-10 border-r border-border-subtle pr-2 text-right select-none',
                  GUTTER_CLASS[line.kind],
                )}
              >
                {line.oldLine ?? ''}
              </td>
              <td
                className={cn(
                  'w-10 min-w-10 border-r border-border-subtle pr-2 text-right select-none',
                  GUTTER_CLASS[line.kind],
                )}
              >
                {line.newLine ?? ''}
              </td>
              <td className="pr-3 pl-2 whitespace-pre text-primary">
                {line.kind === 'add' && <span className="mr-1 text-success select-none">+</span>}
                {line.kind === 'remove' && <span className="mr-1 text-danger select-none">−</span>}
                {line.content}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {maxLines !== undefined && lines.length > maxLines && (
        <div className="border-t border-border-subtle px-3 py-1.5 text-center text-[11px] text-tertiary">
          还有 {lines.length - maxLines} 行未显示
        </div>
      )}
    </div>
  );
}
