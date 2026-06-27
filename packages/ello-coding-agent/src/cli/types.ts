import type { ApprovalMode } from '../config.js';

export interface CliOptions {
  command:
    | 'tui'
    | 'run'
    | 'resume'
    | 'sessions'
    | 'config'
    | 'tools'
    | 'memory'
    | 'permissions'
    | 'tasks'
    | 'help';
  subcommand: string | null;
  prompt: string;
  model?: string;
  modelCandidates: string[];
  baseUrl?: string;
  cwd?: string;
  sessionId?: string;
  allowedPaths: string[];
  mcpConfigPath?: string;
  approvalMode?: ApprovalMode;
  json?: boolean;
  noTui?: boolean;
}
