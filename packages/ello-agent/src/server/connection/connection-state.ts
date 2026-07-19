import type {
  Capability,
  ParsedClientParams,
} from '../../protocol/v1/index.js';

export type ConnectionPhase =
  | 'connected'
  | 'awaitingInitialized'
  | 'ready'
  | 'closed';

/** initialize 状态只属于单条连接，不能泄漏到全局 Server。 */
export class ConnectionState {
  phase: ConnectionPhase = 'connected';
  client: ParsedClientParams<'initialize'> | undefined;
  readonly capabilities: ReadonlySet<Capability>;
  readonly subscribedThreads = new Set<string>();

  constructor(capabilities: readonly Capability[]) {
    this.capabilities = new Set(capabilities);
  }

  initialize(params: ParsedClientParams<'initialize'>): void {
    this.client = params;
    this.phase = 'awaitingInitialized';
  }

  ready(): void {
    this.phase = 'ready';
  }

  close(): void {
    this.phase = 'closed';
  }
}
