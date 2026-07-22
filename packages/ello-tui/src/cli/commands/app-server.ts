import type { Command } from 'commander';

import { runAppServer } from '../server-launcher.js';

/** 注册独立 App Server 进程命令，避免公共 CLI 入口加载服务端实现。 */
export function registerAppServerCommand(program: Command): void {
  program
    .command('app-server')
    .description('run the App Server process')
    .requiredOption('--listen <endpoint>')
    .option('--root <path>')
    .option('--auth-token-env <name>')
    .option('--capabilities <list>', 'comma-separated remote capabilities')
    .action(
      async (commandOptions: {
        listen: string;
        root?: string;
        authTokenEnv?: string;
        capabilities?: string;
      }) => {
        await runAppServer(commandOptions);
      },
    );
}
