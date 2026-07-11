import { randomUUID } from 'node:crypto';

import type { AgentRunResult, AgentStreamEvent } from '@ello/agent';

import { JsonlSessionStore } from '../session/jsonl-store.js';
import { subagentRunsDir } from '../session/paths.js';

import { createSubagentAgent, type SubagentAgentDeps } from './agent-runner.js';
import type { CodingAgentDefinition } from './schema.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 一次 subagent sidechain 运行的句柄。 */
export interface SubagentRun {
  readonly runId: string;
  /** 解析为 subagent 的最终运行结果（已消费完事件流）。 */
  readonly final: Promise<AgentRunResult>;
  /** 中断 subagent 运行（parent abort 或 background cancel 时调用）。 */
  readonly abort: (reason?: unknown) => void;
}

/** {@link runSubagent} 的依赖。 */
export interface SubagentRunDeps extends Omit<SubagentAgentDeps, 'session'> {
  readonly maxTurns?: number;
}

/**
 * 在 parent session 的 sidechain 目录中运行 subagent。
 *
 * sidechain transcript 用于恢复与调试，不进入普通 session list；parent 模型只接收
 * delegate 工具返回的 subagent_run envelope。
 */
export async function runSubagent(input: {
  readonly definition: CodingAgentDefinition;
  readonly prompt: string;
  readonly parentSessionId: string;
  readonly runId?: string;
  readonly deps: SubagentRunDeps;
  readonly onEvent: (runId: string, event: AgentStreamEvent) => void;
}): Promise<SubagentRun> {
  const runId = input.runId ?? randomUUID();
  assertRunId(runId);

  const session = new JsonlSessionStore({
    sessionDir: subagentRunsDir(input.deps.config, input.parentSessionId),
    cwd: input.deps.config.cwd,
    artifacts: input.deps.storage.artifacts,
  });
  await session.repository.open(runId);

  const agent = createSubagentAgent({
    definition: input.definition,
    deps: {
      ...input.deps,
      session,
    },
  });
  const stream = agent.stream(input.prompt, {
    sessionId: runId,
    runId,
    ...(input.deps.maxTurns !== undefined
      ? { maxTurns: input.deps.maxTurns }
      : {}),
  });

  const final = (async (): Promise<AgentRunResult> => {
    try {
      for await (const event of stream) {
        input.onEvent(runId, event);
      }
      return await stream.final;
    } finally {
      await agent.close();
    }
  })();

  return {
    runId,
    final,
    abort: (reason) => stream.abort(reason),
  };
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid subagent run_id: ${runId}`);
  }
}
