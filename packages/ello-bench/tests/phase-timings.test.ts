import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PhaseTimingsArtifactSchema } from '../src/contracts.js';
import { PhaseTimingsRecorder } from '../src/phase-timings.js';

describe('benchmark phase timings', () => {
  it('persists completed and failed phases in execution order', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-phases-'));
    const filePath = path.join(root, 'phase-timings.json');
    const recorder = new PhaseTimingsRecorder(filePath);

    await recorder.run('prepare-workspace', async () => undefined);
    await expect(
      recorder.run('agent-running', async () => {
        throw new Error('agent failed');
      }),
    ).rejects.toThrow('agent failed');

    const artifact = PhaseTimingsArtifactSchema.parse(
      JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    );
    expect(
      artifact.phases.map(({ phase, status }) => ({ phase, status })),
    ).toEqual([
      { phase: 'prepare-workspace', status: 'completed' },
      { phase: 'agent-running', status: 'failed' },
    ]);
  });

  it('rejects duplicate phase names', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ello-bench-phases-'));
    const recorder = new PhaseTimingsRecorder(
      path.join(root, 'phase-timings.json'),
    );

    await recorder.run('prepare-workspace', async () => undefined);
    await expect(
      recorder.run('prepare-workspace', async () => undefined),
    ).rejects.toThrow('already recorded');
  });
});
