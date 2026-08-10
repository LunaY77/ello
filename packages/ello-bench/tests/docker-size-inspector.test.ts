import { describe, expect, it, vi } from 'vitest';

import {
  DockerWritableLayerInspector,
  type DockerSizeInspectResult,
} from '../src/infra/container/docker-size-inspector.js';

const success = (stdout: string): DockerSizeInspectResult => ({
  exitCode: 0,
  timedOut: false,
  stdout,
  stderr: '',
});

describe('Docker writable-layer inspection', () => {
  it('retries a transient daemon disconnect', async () => {
    const inspect = vi
      .fn<(containerName: string) => Promise<DockerSizeInspectResult>>()
      .mockResolvedValueOnce({
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'error during connect: EOF',
      })
      .mockResolvedValueOnce(success('42\n'));
    const wait = vi.fn(() => Promise.resolve());
    const inspector = new DockerWritableLayerInspector(inspect, [250], wait);

    await expect(inspector.writableBytes('container')).resolves.toBe(42);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
  });

  it('serializes concurrent size inspections', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const inspect = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return success('1');
    });
    const inspector = new DockerWritableLayerInspector(inspect, []);

    const first = inspector.writableBytes('first');
    const second = inspector.writableBytes('second');
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await expect(first).resolves.toBe(1);
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(second).resolves.toBe(1);

    expect(maximumActive).toBe(1);
  });

  it('treats a removed container as zero writable bytes', async () => {
    const inspect = vi.fn(() =>
      Promise.resolve({
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'Error: No such container: missing',
      }),
    );
    const inspector = new DockerWritableLayerInspector(inspect, []);

    await expect(inspector.writableBytes('missing')).resolves.toBe(0);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it('reports a persistent inspection failure after bounded retries', async () => {
    const inspect = vi.fn(() =>
      Promise.resolve({
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: 'daemon unavailable',
      }),
    );
    const wait = vi.fn(() => Promise.resolve());
    const inspector = new DockerWritableLayerInspector(
      inspect,
      [100, 200],
      wait,
    );

    await expect(inspector.writableBytes('container')).rejects.toThrow(
      'Docker container size inspect failed: daemon unavailable',
    );
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[100], [200]]);
  });
});
