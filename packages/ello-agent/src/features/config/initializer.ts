/**
 * Config feature 的目录、模板与初始文件创建流程。
 *
 * 模板路径固定相对于当前模块解析，构建过程原样复制 `templates/` 资源。初始化只在目标不存在或
 * 调用方显式要求覆盖时写入；权限错误和其他文件系统失败必须保留原始原因并直接传播。
 */
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
import { fileURLToPath } from 'node:url';

import { errnoCode } from '../../infra/filesystem.js';

import {
  globalCacheDir,
  globalConfigPath,
  globalGitignorePath,
  globalHomeDir,
  globalLogsDir,
  globalMcpPath,
  globalAgentsDir,
  globalSessionsDir,
  globalSkillsDir,
} from './paths.js';

const GLOBAL_GITIGNORE_ENTRIES = [
  'sessions/',
  'logs/',
  'cache/',
  'workspaces/',
] as const;

/**
 * 确保全局 `~/.ello` 根目录存在。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - Promise 在 配置 `initializer` 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
export async function ensureElloHome(): Promise<void> {
  await mkdir(globalHomeDir(), { recursive: true });
}

/**
 * 初始化全局配置和运行目录。
 *
 * 只会在文件不存在时复制模板；传入 force 时才覆盖现有 config/mcp 文件。
 * 工具配置写在 config.yaml 的 `tools` 分组中。
 *
 * Args:
 * - `options`: 仅作用于 `ensureGlobalConfig` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - Promise 在 配置 `initializer` 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
export async function ensureGlobalConfig(
  options: { readonly force?: boolean } = {},
): Promise<void> {
  await ensureElloHome();
  await mkdir(globalSkillsDir(), { recursive: true });
  await mkdir(globalAgentsDir(), { recursive: true });
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

/**
 * 确保内置 skills 的目标目录和用户级 agent 目录存在。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - Promise 在 配置 `initializer` 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
export async function ensureBuiltinAssets(): Promise<void> {
  await mkdir(globalSkillsDir(), { recursive: true });
  await mkdir(globalAgentsDir(), { recursive: true });
}

/**
 * 创建项目级 `.ello/config.yaml` 空文件。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 * - `options`: 仅作用于 `ensureProjectConfig` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
 *
 * Returns:
 * - Promise 在 配置 `initializer` 模块 的异步副作用完整提交后兑现，不返回业务值。
 */
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
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
    await copyFile(templatePath(name), filePath);
  }
}

/** 创建空文件但不覆盖已有内容。 */
async function ensureEmptyFile(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await access(filePath, fsConstants.F_OK);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
    await writeFile(filePath, '', 'utf8');
  }
}

/** 读取可选文本文件；不存在时返回空字符串。 */
async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * 获取构建后可用的内置配置模板路径。
 *
 * Args:
 * - `name`: `templates/` 下的精确资源名；调用方负责传入已知模板。
 *
 * Returns:
 * - 返回相对于当前模块解析的绝对路径，源码与构建产物使用同一目录关系。
 */
function templatePath(name: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, 'templates', name);
}

/**
 * 保留用户已有条目并补齐运行产物目录。
 *
 * Args:
 * - `existing`: 当前 `.gitignore` 的完整文本；文件不存在时由调用方显式传入空字符串。
 *
 * Returns:
 * - 返回去除空行、去重且以换行符结尾的完整文本。
 */
function globalGitignoreTemplate(existing: string): string {
  const lines = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );
  for (const entry of GLOBAL_GITIGNORE_ENTRIES) {
    lines.add(entry);
  }
  return `${[...lines].join('\n')}\n`;
}
