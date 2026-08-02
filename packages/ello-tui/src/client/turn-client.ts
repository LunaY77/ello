import type { AppServerClient } from '../api/client.js';
import type { UserInput } from '../api/protocol-types.js';

import { createSteerId } from './steer-id.js';

export class TurnClient {
  constructor(
    private readonly client: AppServerClient,
    readonly threadId: string,
    readonly turnId: string,
  ) {}

  steer(input: readonly UserInput[], steerId = createSteerId()): Promise<void> {
    return this.client
      .request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.turnId,
        steerId,
        input,
      })
      .then(() => undefined);
  }

  interrupt(reason?: string): Promise<void> {
    return this.client
      .request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.turnId,
        ...(reason === undefined ? {} : { reason }),
      })
      .then(() => undefined);
  }
}
