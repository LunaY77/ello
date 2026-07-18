export interface GlobalCliOptions {
  readonly remote?: string;
  readonly remoteAuthTokenEnv?: string;
  readonly root?: string;
  readonly json?: boolean;
  readonly noTui?: boolean;
  readonly timeout?: number;
}

export function authTokenFromOptions(options: GlobalCliOptions): string | undefined {
  if (options.remoteAuthTokenEnv === undefined) return undefined;
  const token = process.env[options.remoteAuthTokenEnv];
  if (token === undefined || token === '') throw new Error(`Authentication token environment variable ${options.remoteAuthTokenEnv} is empty.`);
  return token;
}
