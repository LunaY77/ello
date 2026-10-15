/** 测试中按真实生产 seam 创建 Command Run runtime。 */
import type { z } from 'zod';

import {
  createCommandRegistrySnapshot,
  createCommandRunRuntime,
  commandInput,
  defineCommand,
  defineCommandModule,
  structuredInput,
  type CommandContext,
  type CommandDefinition,
  type CommandExposure,
  type CommandRisk,
  type MaybePromise,
} from '../../src/features/command/index.js';

/** 声明测试专用的 structured Command。 */
export function defineTestCommand<
  TInput extends Record<string, unknown>,
  TOutput,
>(options: {
  readonly name: string;
  readonly summary: string;
  readonly aliases?: readonly string[];
  readonly risk?: CommandRisk;
  readonly exposure?: CommandExposure;
  readonly schema: z.ZodType<TInput>;
  readonly run: (
    input: TInput,
    context: CommandContext,
  ) => MaybePromise<TOutput>;
}): CommandDefinition {
  return defineCommand({
    name: options.name,
    summary: options.summary,
    aliases: options.aliases ?? [],
    risk: options.risk ?? 'readonly',
    exposure: options.exposure ?? 'discoverable',
    invocation: structuredInput(commandInput(options.schema)),
    execution: { kind: 'immediate', run: options.run },
  });
}

/** 用给定领域能力构造测试 runtime。 */
export function createTestCommandRun(commands: readonly CommandDefinition[]) {
  return createCommandRunRuntime(
    createCommandRegistrySnapshot({
      modules: [defineCommandModule({ id: 'test', commands })],
      search: { resultLimit: 6, maxResultBytes: 24_000 },
    }),
  );
}
