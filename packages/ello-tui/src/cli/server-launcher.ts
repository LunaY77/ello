import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface AppServerLaunchOptions {
  readonly listen: string;
  readonly root?: string;
  readonly authTokenEnv?: string;
  readonly capabilities?: string;
}

export async function runAppServer(
  options: AppServerLaunchOptions,
): Promise<void> {
  const entryPath = fileURLToPath(
    import.meta.resolve('@ello/agent/server-entry'),
  );
  const child = spawn(
    process.execPath,
    [
      entryPath,
      '--listen',
      options.listen,
      ...(options.root === undefined ? [] : ['--root', options.root]),
      ...(options.authTokenEnv === undefined
        ? []
        : ['--auth-token-env', options.authTokenEnv]),
      ...(options.capabilities === undefined
        ? []
        : ['--capabilities', options.capabilities]),
    ],
    { stdio: 'inherit', env: process.env },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ello-agent exited with code ${String(code)} (${String(signal)}).`,
          ),
        );
    });
  });
}
