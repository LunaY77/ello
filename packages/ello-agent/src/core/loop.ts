import { callModel } from './model-call.js';
import { buildModelInput } from './model-input.js';
import type { RunSession } from './run-session.js';
import { executeToolCalls } from './tool-execution.js';

export async function runAgentLoop(run: RunSession): Promise<void> {
  try {
    await run.start();

    while (run.canStartTurn()) {
      const turn = await run.startTurn();
      if (turn.skipModel === 'interrupted') {
        await run.finishTurn(
          turn,
          undefined,
          undefined,
          { messages: [], toolCalls: [], pendingCount: 0 },
          'interrupted',
        );
        break;
      }

      const input = await buildModelInput(run);
      const assistant = await callModel(run, input);
      const toolResults = await executeToolCalls(run, assistant);

      await run.finishTurn(
        turn,
        input.diagnostics,
        assistant.response,
        toolResults,
        assistant.stopReason,
      );

      if (run.shouldStopAfterTurn()) {
        break;
      }
    }

    await run.finish();
  } catch (error) {
    await run.fail(error);
  }
}
