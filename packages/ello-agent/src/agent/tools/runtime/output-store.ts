import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ToolOutputLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly previewLines: number;
}

export interface ToolOutputStore {
  writeLargeOutput(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly callId: string;
    readonly content: string;
    readonly preferredName: string;
  }): Promise<{ readonly outputPath: string }>;
}

export class SessionToolOutputStore implements ToolOutputStore {
  constructor(private readonly sessionDir: string) {}

  async writeLargeOutput(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly callId: string;
    readonly content: string;
    readonly preferredName: string;
  }): Promise<{ readonly outputPath: string }> {
    const dir = path.join(
      this.sessionDir,
      input.sessionId,
      'artifacts',
      input.runId,
      input.callId,
    );
    await mkdir(dir, { recursive: true });
    const outputPath = path.join(dir, safeFileName(input.preferredName));
    await writeFile(outputPath, input.content, 'utf8');
    return { outputPath };
  }
}

export async function persistLargeOutput(input: {
  readonly output: string;
  readonly limits: ToolOutputLimits;
  readonly store: ToolOutputStore;
  readonly sessionId: string;
  readonly runId: string;
  readonly callId: string;
  readonly preferredName: string;
}): Promise<
  | { readonly output: string; readonly truncated: false }
  | {
      readonly output: string;
      readonly truncated: true;
      readonly outputPath: string;
    }
> {
  if (!shouldTruncate(input.output, input.limits)) {
    return { output: input.output, truncated: false };
  }
  const artifact = await input.store.writeLargeOutput({
    sessionId: input.sessionId,
    runId: input.runId,
    callId: input.callId,
    content: input.output,
    preferredName: input.preferredName,
  });
  return {
    output: previewOutput(input.output, input.limits.previewLines),
    truncated: true,
    outputPath: artifact.outputPath,
  };
}

function shouldTruncate(value: string, limits: ToolOutputLimits): boolean {
  return (
    Buffer.byteLength(value, 'utf8') > limits.maxBytes ||
    value.split(/\r?\n/u).length > limits.maxLines
  );
}

function previewOutput(value: string, previewLines: number): string {
  const lines = value.split(/\r?\n/u);
  return `${lines.slice(0, previewLines).join('\n')}\n... truncated; full output written to artifact ...`;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(0, 120) || 'output.txt';
}
