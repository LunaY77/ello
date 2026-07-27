/**
 * 环境 feature 生成文件系统和 shell 的运行上下文说明。
 *
 * 说明内容只反映当前环境的工作目录、允许路径和可选可执行文件。
 */
/**
 * 渲染单个环境能力的 XML 上下文片段。
 *
 * Args:
 * - `kind`: 要描述的环境能力类型。
 * - `cwd`: 当前工作目录。
 * - `allowedPaths`: 当前能力允许访问的规范路径集合。
 * - `executable`: shell 使用的可选可执行文件。
 *
 * Returns:
 * - 返回可直接嵌入 system context 的 XML 片段。
 */
export function environmentInstructions(
  kind: 'file-system' | 'shell',
  cwd: string,
  allowedPaths: ReadonlyArray<string>,
  executable?: string,
): string {
  return [
    `<${kind}>`,
    `  <working-directory>${cwd}</working-directory>`,
    ...allowedPaths.map(
      (allowedPath) => `  <allowed-path>${allowedPath}</allowed-path>`,
    ),
    ...(executable === undefined
      ? []
      : [`  <executable>${executable}</executable>`]),
    `</${kind}>`,
  ].join('\n');
}
