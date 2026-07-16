import type { Command } from 'commander';

import type { CodingAgentConfig } from '../config/index.js';

export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  readonly stdin?: NodeJS.ReadableStream;
}

export interface GlobalOpts {
  readonly profile?: string;
  readonly cwd?: string;
  readonly allowedPath?: string[];
  readonly mode?: string;
  readonly json?: boolean;
  readonly tui?: boolean;
}

export interface CliCommandContext {
  readonly io: CliIo;
  resolveConfig(opts: GlobalOpts): Promise<CodingAgentConfig>;
}

export interface CliCommandModule {
  register(program: Command, ctx: CliCommandContext): void;
}
