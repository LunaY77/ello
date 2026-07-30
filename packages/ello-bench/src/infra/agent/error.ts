import type {
  AgentAdapterFailure,
  AgentFailureKind,
} from '../../ports/agent.js';

export class AgentAdapterError extends Error implements AgentAdapterFailure {
  readonly agentFailure = true as const;

  constructor(
    readonly kind: AgentFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentAdapterError';
  }
}
