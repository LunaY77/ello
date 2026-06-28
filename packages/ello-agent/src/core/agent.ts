import { randomUUID } from 'node:crypto';

import type {
  Agent,
  AgentInput,
  AgentRunOptions,
  AgentRunResult,
  AgentStream,
  CreateAgentOptions,
  ModelAdapter,
} from '../public/types.js';

import { closeAgentResources } from './events.js';
import { runAgentLoop } from './loop.js';
import { createRunSession, defaultModelAdapter } from './run-session.js';

export class ElloAgent implements Agent {
  private readonly extensions;
  private readonly environment;
  private readonly modelAdapter: ModelAdapter;
  private setupDone = false;

  constructor(private readonly config: CreateAgentOptions) {
    this.extensions = config.extensions ?? [];
    this.environment = config.environment ?? {};
    this.modelAdapter = config.modelAdapter ?? defaultModelAdapter();
  }

  async run(
    input: AgentInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const stream = this.stream(input, options);
    for await (const _event of stream) {
      // consume stream to completion
    }
    return stream.final;
  }

  stream(input: AgentInput, options: AgentRunOptions = {}): AgentStream {
    const run = createRunSession({
      config: this.config,
      input,
      runOptions: options,
      environment: this.environment,
      extensions: this.extensions,
      modelAdapter: this.modelAdapter,
      setup: () => this.setup(),
    });
    void runAgentLoop(run);
    return run.stream;
  }

  resume(
    deferred: NonNullable<AgentRunOptions['resume']>,
    options: AgentRunOptions = {},
  ): AgentStream {
    return this.stream({ messages: [] }, { ...options, resume: deferred });
  }

  async close(): Promise<void> {
    await closeAgentResources(this.environment, this.extensions);
  }

  private async setup(): Promise<void> {
    if (this.setupDone) {
      return;
    }
    this.setupDone = true;
    for (const extension of this.extensions) {
      await extension.setup?.({ agentId: randomUUID() });
    }
  }
}
