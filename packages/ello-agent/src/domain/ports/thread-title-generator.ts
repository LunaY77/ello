import type { ThreadSnapshot } from '../../protocol/v1/index.js';

export interface ThreadTitleGenerator {
  generate(
    snapshot: ThreadSnapshot,
    signal: AbortSignal,
  ): Promise<string | undefined>;
}
