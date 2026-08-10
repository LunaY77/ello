export interface DockerSizeInspectResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
}

export type DockerSizeInspect = (
  containerName: string,
) => Promise<DockerSizeInspectResult>;

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/**
 * `docker inspect --size` is expensive on overlay2. Keep these calls serialized
 * and retry short daemon disconnects instead of creating a thundering herd.
 */
export class DockerWritableLayerInspector {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly inspect: DockerSizeInspect,
    private readonly retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
    private readonly wait: (timeoutMs: number) => Promise<void> = delay,
  ) {
    if (retryDelaysMs.some((timeoutMs) => timeoutMs < 0)) {
      throw new Error('Docker size inspect retry delays must be nonnegative.');
    }
  }

  async writableBytes(containerName: string): Promise<number> {
    if (containerName === '') {
      throw new Error('Docker container name must not be empty.');
    }
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.inspectWithRetries(containerName);
    } finally {
      release();
    }
  }

  private async inspectWithRetries(containerName: string): Promise<number> {
    let failure: Error | undefined;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        const result = await this.inspect(containerName);
        if (
          result.exitCode !== 0 ||
          result.timedOut ||
          result.stdout === undefined
        ) {
          if (
            !result.timedOut &&
            result.stderr?.includes('No such container')
          ) {
            return 0;
          }
          failure = new Error(
            `Docker container size inspect failed${result.timedOut ? ' (timed out)' : ''}: ${result.stderr ?? ''}`,
          );
        } else {
          const bytes = Number(result.stdout.trim());
          if (Number.isSafeInteger(bytes) && bytes >= 0) return bytes;
          failure = new Error(
            `Docker container size inspect returned an invalid value: ${result.stdout}`,
          );
        }
      } catch (error) {
        failure = new Error(
          `Docker container size inspect failed: ${errorMessage(error)}`,
        );
      }
      const retryDelay = this.retryDelaysMs[attempt];
      if (retryDelay !== undefined) await this.wait(retryDelay);
    }
    throw requiredFailure(failure);
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredFailure(error: Error | undefined): Error {
  if (error === undefined) {
    throw new Error('Docker container size inspect failure is missing.');
  }
  return error;
}
