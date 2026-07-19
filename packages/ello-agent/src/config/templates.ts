import path from 'node:path';
import { fileURLToPath } from 'node:url';

const globalGitignoreEntries = ['sessions/', 'logs/', 'cache/', 'workspaces/'];

/** 获取构建后可用的模板文件路径；package build 会把 templates 目录复制到 dist。 */
export function templatePath(name: string): string {
  // 模板与 config 模块同目录维护，构建时原样复制到 dist。
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, 'templates', name);
}

/** 合并生成 `~/.ello/.gitignore`，保留用户已有条目并追加运行产物目录。 */
export function globalGitignoreTemplate(existing = ''): string {
  const lines = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  for (const entry of globalGitignoreEntries) {
    lines.add(entry);
  }
  return `${[...lines].join('\n')}\n`;
}
