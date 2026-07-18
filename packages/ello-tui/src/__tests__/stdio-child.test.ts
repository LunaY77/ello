import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { LocalChildStderrRouter } from '../api/transports/stdio-child.js';

describe('LocalChildStderrRouter', () => {
  it('过滤跨 chunk 的本地 Server info 生命周期日志', () => {
    const { output, router } = createRouter();

    router.push(Buffer.from('{"level":"info","event":"server.'));
    router.push(Buffer.from('stopping","reason":"stdio EOF"}\n'));
    router.end();

    expect(output()).toBe('');
  });

  it('保留 warning、error 和非 JSON stderr', () => {
    const { output, router } = createRouter();

    router.push(
      Buffer.from(
        [
          '{"level":"warn","event":"server.slow"}',
          '{"level":"error","event":"server.failed"}',
          'native stderr',
          'final partial',
        ].join('\n'),
      ),
    );
    router.end();

    expect(output()).toBe(
      [
        '{"level":"warn","event":"server.slow"}',
        '{"level":"error","event":"server.failed"}',
        'native stderr',
        'final partial',
      ].join('\n'),
    );
  });
});

function createRouter(): {
  readonly router: LocalChildStderrRouter;
  readonly output: () => string;
} {
  const target = new PassThrough();
  const chunks: Buffer[] = [];
  target.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    router: new LocalChildStderrRouter(target),
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}
