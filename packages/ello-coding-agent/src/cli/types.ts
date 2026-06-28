import type { ApprovalMode } from '../config.js';

export type CliCommand =
  | 'tui'
  | 'run'
  | 'rpc'
  | 'resume'
  | 'sessions'
  | 'config'
  | 'tools'
  | 'memory'
  | 'permissions'
  | 'help';

/** 顶层 CLI 解析结果。 */
export interface CliOptions {
  readonly command: CliCommand;
  readonly subcommand: string | null;
  readonly prompt: string;
  readonly model?: string;
  readonly modelCandidates: string[];
  readonly baseUrl?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly allowedPaths: string[];
  readonly mcpConfigPath?: string;
  readonly approvalMode?: ApprovalMode;
  readonly json?: boolean;
  readonly noTui?: boolean;
}
