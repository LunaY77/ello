import type { Command } from 'commander';

import type { GlobalCliOptions } from '../types.js';

/** 将 Commander 的动态 option 对象收窄为 CLI 公共边界类型。 */
export function resolveGlobalOptions(command: Command): GlobalCliOptions {
  const values: unknown = command.optsWithGlobals();
  if (!isRecord(values)) {
    throw new Error('Commander returned invalid global options.');
  }
  return {
    ...(typeof values.remote === 'string' ? { remote: values.remote } : {}),
    ...(typeof values.remoteAuthTokenEnv === 'string'
      ? { remoteAuthTokenEnv: values.remoteAuthTokenEnv }
      : {}),
    ...(typeof values.root === 'string' ? { root: values.root } : {}),
    ...(values.json === true ? { json: true } : {}),
    ...(values.tui === false ? { noTui: true } : {}),
  };
}

export function normalizeOptions(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error('Commander returned invalid options.');
  const values = input;
  return {
    ...(typeof values.thread === 'string' ? { thread: values.thread } : {}),
    ...(typeof values.model === 'string' ? { model: values.model } : {}),
    ...(typeof values.profile === 'string' ? { profile: values.profile } : {}),
    ...(typeof values.mode === 'string' ? { mode: values.mode } : {}),
    ...(values.json === true ? { json: true } : {}),
    ...(values.tui === false ? { noTui: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
