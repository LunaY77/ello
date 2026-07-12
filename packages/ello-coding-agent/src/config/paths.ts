import { homedir } from 'node:os';
import path from 'node:path';

/** 全局配置根目录；ELLO_HOME 用于测试和运行隔离。 */
export function elloHomeDir(): string {
  if (process.env.ELLO_HOME?.trim()) {
    return path.resolve(process.env.ELLO_HOME);
  }
  return path.join(homedir(), '.ello');
}

export const globalHomeDir = elloHomeDir;

/** 全局用户配置文件，随启动自动初始化。 */
export function globalConfigPath(): string {
  return path.join(elloHomeDir(), 'config.yaml');
}

/** MCP 服务器配置文件，仍单独保存为 JSON。 */
export function globalMcpPath(): string {
  return path.join(elloHomeDir(), 'mcp.json');
}

/** `~/.ello/.gitignore`，用于屏蔽 sessions/logs/cache 等运行产物。 */
export function globalGitignorePath(): string {
  return path.join(elloHomeDir(), '.gitignore');
}

/** 用户安装或生成的 skills 目录。 */
export function globalSkillsDir(): string {
  return path.join(elloHomeDir(), 'skills');
}

/** 用户安装或生成的 Markdown agent 目录。 */
export function globalAgentsDir(): string {
  return path.join(elloHomeDir(), 'agents');
}

/** 会话 JSONL 默认目录。 */
export function globalSessionsDir(): string {
  return path.join(elloHomeDir(), 'sessions');
}

/** 运行日志目录。 */
export function globalLogsDir(): string {
  return path.join(elloHomeDir(), 'logs');
}

/** 临时缓存目录。 */
export function globalCacheDir(): string {
  return path.join(elloHomeDir(), 'cache');
}

/** 项目内 `.ello` 目录。 */
export function projectElloDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.ello');
}

/** 项目级共享配置文件。 */
export function projectConfigPath(cwd: string): string {
  return path.join(projectElloDir(cwd), 'config.yaml');
}

/** 项目级 skills 覆盖目录。 */
export function projectSkillsDir(cwd: string): string {
  return path.join(projectElloDir(cwd), 'skills');
}

/** 项目级 Markdown agent 覆盖目录。 */
export function projectAgentsDir(cwd: string): string {
  return path.join(projectElloDir(cwd), 'agents');
}
