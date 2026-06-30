import { constants as fsConstants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  globalCacheDir,
  globalConfigPath,
  globalGitignorePath,
  globalHomeDir,
  globalLogsDir,
  globalMcpPath,
  globalSessionsDir,
  globalSkillsDir,
  globalSubagentsDir,
  globalTasksDir,
} from './paths.js';
import { globalGitignoreTemplate, templatePath } from './templates.js';

/** 确保全局 `~/.ello` 根目录存在。 */
export async function ensureElloHome(): Promise<void> {
  await mkdir(globalHomeDir(), { recursive: true });
}

/**
 * 初始化全局配置和运行目录。
 *
 * 只会在文件不存在时复制模板；传入 force 时才覆盖现有 config/mcp 文件。
 * 工具配置写在 config.yaml 的 `tools` 分组中。
 */
export async function ensureGlobalConfig(
  options: { readonly force?: boolean } = {},
): Promise<void> {
  await ensureElloHome();
  await mkdir(globalSkillsDir(), { recursive: true });
  await mkdir(globalSubagentsDir(), { recursive: true });
  await mkdir(globalTasksDir(), { recursive: true });
  await mkdir(globalSessionsDir(), { recursive: true });
  await mkdir(globalLogsDir(), { recursive: true });
  await mkdir(globalCacheDir(), { recursive: true });
  await ensureTemplateFile(globalConfigPath(), 'config.yaml', options);
  await ensureTemplateFile(globalMcpPath(), 'mcp.json', options);
  const existing = await readTextIfExists(globalGitignorePath());
  const nextGitignore = globalGitignoreTemplate(existing);
  if (nextGitignore !== existing) {
    await writeFile(globalGitignorePath(), nextGitignore, 'utf8');
  }
}

/** 确保内置 skills/subagents 的目标目录存在，实际资产由构建复制。 */
export async function ensureBuiltinAssets(): Promise<void> {
  await mkdir(globalSkillsDir(), { recursive: true });
  await mkdir(globalSubagentsDir(), { recursive: true });
}

/** 创建项目级 `.ello/config.yaml` 空文件。 */
export async function ensureProjectConfig(
  cwd: string,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  const projectDir = `${path.resolve(cwd)}/.ello`;
  await mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, 'config.yaml');
  if (options.force === true) {
    await rm(filePath, { force: true });
  }
  await ensureEmptyFile(filePath);
}

/** 从包内 templates 复制单个全局模板文件。 */
async function ensureTemplateFile(
  filePath: string,
  name: string,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (options.force === true) {
    await copyFile(templatePath(name), filePath);
    return;
  }
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    await copyFile(templatePath(name), filePath);
  }
}

/** 创建空文件但不覆盖已有内容。 */
async function ensureEmptyFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    await writeFile(filePath, '', 'utf8');
  }
}

/** 读取可选文本文件；不存在时返回空字符串。 */
async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}
