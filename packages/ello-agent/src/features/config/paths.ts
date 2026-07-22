/**
 * 本文件负责 config feature 的路径推导与路径约束。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * 全局配置根目录；ELLO_HOME 用于测试和运行隔离。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `elloHomeDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function elloHomeDir(): string {
  if (process.env.ELLO_HOME?.trim()) {
    return path.resolve(process.env.ELLO_HOME);
  }
  return path.join(homedir(), '.ello');
}

export const globalHomeDir = elloHomeDir;

/**
 * 全局用户配置文件，随启动自动初始化。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalConfigPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalConfigPath(): string {
  return path.join(elloHomeDir(), 'config.yaml');
}

/**
 * MCP 服务器配置文件，仍单独保存为 JSON。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalMcpPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalMcpPath(): string {
  return path.join(elloHomeDir(), 'mcp.json');
}

/**
 * `~/.ello/.gitignore`，用于屏蔽 sessions/logs/cache 等运行产物。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalGitignorePath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalGitignorePath(): string {
  return path.join(elloHomeDir(), '.gitignore');
}

/**
 * 用户安装或生成的 skills 目录。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalSkillsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalSkillsDir(): string {
  return path.join(elloHomeDir(), 'skills');
}

/**
 * 用户安装或生成的 Markdown agent 目录。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalAgentsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalAgentsDir(): string {
  return path.join(elloHomeDir(), 'agents');
}

/**
 * 会话 JSONL 默认目录。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalSessionsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalSessionsDir(): string {
  return path.join(elloHomeDir(), 'sessions');
}

/**
 * 运行日志目录。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalLogsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalLogsDir(): string {
  return path.join(elloHomeDir(), 'logs');
}

/**
 * 临时缓存目录。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `globalCacheDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function globalCacheDir(): string {
  return path.join(elloHomeDir(), 'cache');
}

/**
 * 项目内 `.ello` 目录。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `projectElloDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectElloDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.ello');
}

/**
 * 项目级共享配置文件。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `projectConfigPath` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectConfigPath(cwd: string): string {
  return path.join(projectElloDir(cwd), 'config.yaml');
}

/**
 * 项目级 skills 覆盖目录。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `projectSkillsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectSkillsDir(cwd: string): string {
  return path.join(projectElloDir(cwd), 'skills');
}

/**
 * 执行 配置 `paths` 模块 定义的 `projectPermissionsFile` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `projectPermissionsFile` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectPermissionsFile(cwd: string): string {
  return path.join(projectElloDir(cwd), 'permissions.yaml');
}

/**
 * 执行 配置 `paths` 模块 定义的 `userPermissionsFile` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `userPermissionsFile` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function userPermissionsFile(): string {
  return path.join(elloHomeDir(), 'permissions.yaml');
}

/**
 * 项目级 Markdown agent 覆盖目录。
 *
 * Args:
 * - `cwd`: 调用方指定的文件系统位置；路径边界和存在性由当前操作显式校验。
 *
 * Returns:
 * - 返回 `projectAgentsDir` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function projectAgentsDir(cwd: string): string {
  return path.join(projectElloDir(cwd), 'agents');
}
