/**
 * 统一 diff 解析。
 *
 * 对话历史里的 edit/write 改动要展示「清晰的 unified diff」：行号、文件头、hunk 头、
 * 增删上色、可折叠。审批弹窗只用 {@link summarizeDiff} 给出 +N/-M 摘要，不塞完整 diff。
 * 解析是纯函数，便于单测。
 */
export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 旧文件行号（context/del 行有值）。 */
  readonly oldNo?: number;
  /** 新文件行号（context/add 行有值）。 */
  readonly newNo?: number;
}

export interface DiffSummary {
  readonly added: number;
  readonly removed: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** 把统一 diff 文本解析为带行号的结构化行。 */
export function parseUnifiedDiff(diff: string): readonly DiffLine[] {
  if (diff.trim() === '') {
    return [];
  }
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split(/\r?\n/u)) {
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      out.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) {
      out.push({ kind: 'file', text: raw });
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk !== null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw, newNo });
      newNo += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw, oldNo });
      oldNo += 1;
      continue;
    }
    // 空串也算上下文行（diff 中的空行）。
    out.push({ kind: 'context', text: raw, oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }
  return out;
}

/** 统计增删行数，用于审批摘要。 */
export function summarizeDiff(diff: string): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const line of parseUnifiedDiff(diff)) {
    if (line.kind === 'add') {
      added += 1;
    } else if (line.kind === 'del') {
      removed += 1;
    }
  }
  return { added, removed };
}
