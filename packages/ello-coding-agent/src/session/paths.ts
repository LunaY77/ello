import { homedir } from 'node:os';
import path from 'node:path';

import type { CodingAgentConfig } from '../config/index.js';

/**
 * `~/.ello` 与 `<repo>/.ello` 的目录布局解析。
 *
 * 所有「文件系统状态」的路径落点：把散落在各处的路径拼接集中到一处，
 * 让会话存储、权限规则、检查点、技能、日志都从这里取路径，
 * 而不是各自调用 `path.join(homedir(), ...)`。
 *
 * 设计原则：
 * - 全局状态放 `~/.ello`（跨仓库共享：全局配置、记忆、技能、日志、缓存）。
 * - 项目状态放 `<cwd>/.ello`（随仓库走：项目配置、项目技能、权限规则、检查点）。
 * - 会话 JSONL 默认落全局 `sessionDir`（已由 config 规范化为绝对路径）。
 */

/** 全局 ello 目录：`~/.ello`。 */
export function globalDir(): string {
  return path.join(homedir(), '.ello');
}

/** 项目级 ello 目录：`<cwd>/.ello`。 */
export function projectDir(cwd: string): string {
  return path.join(path.resolve(cwd), '.ello');
}

/** 会话 JSONL 根目录。已在 `config.sessionDir` 规范化为绝对路径。 */
export function sessionsDir(config: CodingAgentConfig): string {
  return config.sessionDir;
}

/** 单个会话 JSONL 文件路径：`<sessionDir>/<sessionId>.jsonl`。 */
export function sessionFile(
  config: CodingAgentConfig,
  sessionId: string,
): string {
  return path.join(sessionsDir(config), `${sessionId}.jsonl`);
}

/** subagent sidechain 根目录：`<sessionDir>/<sessionId>/subagents`。 */
export function subagentRunsDir(
  config: CodingAgentConfig,
  sessionId: string,
): string {
  return path.join(sessionsDir(config), sessionId, 'subagents');
}

/** 项目级检查点目录：`<cwd>/.ello/checkpoints`。 */
export function checkpointsDir(cwd: string): string {
  return path.join(projectDir(cwd), 'checkpoints');
}

/** 项目级视图状态目录：`<cwd>/.ello/state`。 */
export function stateDir(cwd: string): string {
  return path.join(projectDir(cwd), 'state');
}

/** 项目级权限规则文件：`<cwd>/.ello/permissions.yaml`。 */
export function projectPermissionsFile(cwd: string): string {
  return path.join(projectDir(cwd), 'permissions.yaml');
}

/** 全局技能目录：`~/.ello/skills`。 */
export function globalSkillsDir(): string {
  return path.join(globalDir(), 'skills');
}

/** 项目技能目录：`<cwd>/.ello/skills`。 */
export function projectSkillsDir(cwd: string): string {
  return path.join(projectDir(cwd), 'skills');
}

/** 全局日志目录：`~/.ello/logs`。 */
export function logsDir(): string {
  return path.join(globalDir(), 'logs');
}

/** 全局记忆目录：`~/.ello/memory`。 */
export function memoryDir(): string {
  return path.join(globalDir(), 'memory');
}
