import { describe, expect, it } from 'vitest';

import { JsonlFramer } from '../../src/api/transports/jsonl-framer.js';

const decoder = new TextDecoder();

describe('JsonlFramer', () => {
  it('pauses a burst larger than its queue and resumes without dropping lines', async () => {
    const pressure: boolean[] = [];
    const framer = new JsonlFramer(undefined, (backpressured) =>
      pressure.push(backpressured),
    );
    const lines = Array.from({ length: 300 }, (_, index) =>
      JSON.stringify({ index }),
    );

    framer.push(Buffer.from(`${lines.join('\n')}\n`));
    framer.end();

    const received: string[] = [];
    for await (const message of framer.messages) {
      received.push(decoder.decode(message));
    }

    expect(received).toEqual(lines);
    expect(pressure).toContain(true);
  });
});
