import type { AgentRuntime, AgentRuntimeRunInput } from '../agents.js';

import { AgentStreamer } from './streamer.js';

/** streamAgent 参数。 */
export interface StreamAgentOptions {
  agentId?: string;
  agentName?: string;
}

/** `agent.stream()` 的函数式入口。 */
export function streamAgent(
  runtime: AgentRuntime,
  input: AgentRuntimeRunInput,
  _options: StreamAgentOptions = {},
) {
  if (runtime.entered) {
    return runtime.stream(input);
  }

  const streamer = new AgentStreamer<Awaited<ReturnType<AgentRuntime['run']>>>();
  streamer.addTask(
    (async () => {
      await runtime.enter();
      try {
        const inner = runtime.stream(input);
        for await (const event of inner) {
          streamer.enqueue(event);
        }
        streamer.setResult(await inner.result());
        streamer.run = inner.run;
        streamer.finish();
      } finally {
        await runtime.exit();
      }
    })(),
  );
  return streamer;
}
