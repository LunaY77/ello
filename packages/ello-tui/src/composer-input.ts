export interface ComposerSubmitResult {
  submitted: boolean;
  value: string;
}

/**
 * 将结尾反斜杠提交转换为插入换行。
 */
export function resolveComposerSubmit(value: string): ComposerSubmitResult {
  if (value.endsWith('\\')) {
    return {
      submitted: false,
      value: `${value.slice(0, -1)}\n`,
    };
  }
  return { submitted: true, value };
}

/**
 * 将多行输入渲染为稳定的终端行，供 composer 预览使用。
 */
export function composerRows(value: string): string[] {
  const rows = value.split('\n');
  return rows.length === 0 ? [''] : rows;
}
