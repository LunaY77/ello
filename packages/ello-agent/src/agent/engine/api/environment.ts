import type { AgentRunContext } from './agent.js';
import type { MaybePromise } from './model.js';

export interface AgentFileSystem {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  getContextInstructions?(): MaybePromise<string | null>;
  close?(): MaybePromise<void>;
}

export interface AgentShell {
  run(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    },
  ): Promise<AgentShellResult>;
  getContextInstructions?(): MaybePromise<string | null>;
  close?(): MaybePromise<void>;
}

export interface AgentShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 运行环境只通过一个文件系统入口和一个指令生命周期入口向内核提供能力。 */
export interface AgentEnvironment {
  readonly fileSystem?: AgentFileSystem;
  readonly shell?: AgentShell;
  readonly resources?: AgentResourceRegistry;
  setup?(ctx: AgentRunContext): MaybePromise<void>;
  getInstructions?(ctx: AgentRunContext): MaybePromise<string | null>;
  close?(): MaybePromise<void>;
}

export interface AgentResource {
  setup?(): MaybePromise<void>;
  close?(): MaybePromise<void>;
  getContextInstructions?(): MaybePromise<string | null>;
}

export type AgentResourceFactory = (
  environment: AgentEnvironment,
) => MaybePromise<AgentResource>;

export interface AgentResourceRegistry {
  bind?(environment: AgentEnvironment): void;
  setupAll?(): MaybePromise<void>;
  register(key: string, resource: AgentResource): void;
  registerFactory(key: string, factory: AgentResourceFactory): void;
  get(key: string): AgentResource | undefined;
  getOrCreate(key: string): Promise<AgentResource>;
  keys(): string[];
  getContextInstructions?(): MaybePromise<string | null>;
  closeAll?(): MaybePromise<void>;
}
