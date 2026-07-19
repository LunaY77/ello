import type { MemoryScope } from './paths.js';

export type MemoryEvent =
  | {
      readonly type: 'memory.saved';
      readonly scope: MemoryScope;
      readonly file: string;
      readonly operation: 'created' | 'updated' | 'deleted';
    }
  | {
      readonly type: 'memory.extraction.started';
      readonly jobId: string;
      readonly sessionId: string;
    }
  | {
      readonly type: 'memory.extraction.completed';
      readonly jobId: string;
      readonly changes: number;
    }
  | {
      readonly type: 'memory.extraction.failed';
      readonly jobId: string;
      readonly error: string;
    }
  | { readonly type: 'memory.dream.started'; readonly jobId: string }
  | {
      readonly type: 'memory.dream.completed';
      readonly jobId: string;
      readonly changes: number;
      readonly summary: string;
    }
  | {
      readonly type: 'memory.dream.failed';
      readonly jobId: string;
      readonly error: string;
    };
