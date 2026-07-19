import type {
  PendingServerRequest,
  ThreadItem,
  Plan,
  ThreadSnapshot,
  Turn,
  Usage,
  UserInput,
} from '../../protocol/v1/index.js';
import type { NewThreadRecord } from '../../storage/threads/thread-record.js';

export type ItemDelta = Extract<
  NewThreadRecord,
  { readonly kind: 'item.delta' }
>['delta'];

export type TurnExecutionEvent =
  | { readonly type: 'itemStarted'; readonly item: ThreadItem }
  | {
      readonly type: 'itemDelta';
      readonly itemId: string;
      readonly delta: ItemDelta;
    }
  | { readonly type: 'itemCompleted'; readonly item: ThreadItem }
  | { readonly type: 'planUpdated'; readonly plan: Plan }
  | {
      readonly type: 'goalUpdated';
      readonly goal: NonNullable<ThreadSnapshot['goal']>;
    }
  | {
      readonly type: 'settingsUpdated';
      readonly settings: ThreadSnapshot['settings'];
    }
  | {
      readonly type: 'serverRequest';
      readonly request: PendingServerRequest;
    }
  | { readonly type: 'usage'; readonly usage: Usage };

export type TurnExecutionResult =
  | { readonly status: 'completed'; readonly usage: Usage }
  | {
      readonly status: 'interrupted';
      readonly usage: Usage;
      readonly reason: string;
    }
  | {
      readonly status: 'failed';
      readonly usage: Usage;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface TurnExecutionHandle {
  readonly events: AsyncIterable<TurnExecutionEvent>;
  readonly final: Promise<TurnExecutionResult>;
  steer(input: readonly UserInput[]): Promise<void>;
  interrupt(reason: string): Promise<void>;
  resolveServerRequest(requestId: string, result: unknown): Promise<void>;
  rejectServerRequest(
    requestId: string,
    error: { readonly code: number; readonly message: string },
  ): Promise<void>;
}

export interface TurnExecutor {
  start(input: {
    readonly thread: ThreadSnapshot;
    readonly turn: Turn;
    readonly userInput: readonly UserInput[];
  }): Promise<TurnExecutionHandle>;
  close(): Promise<void>;
}

export type TurnExecutorFactory = (
  thread: ThreadSnapshot,
) => Promise<TurnExecutor>;
