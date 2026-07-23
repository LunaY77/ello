import type { Command } from 'commander';

import type { AppServerClient } from '../../api/client.js';
import type { ServerNotification } from '../../api/protocol-types.js';
import { createThreadClient } from '../../client/thread-client.js';
import { renderSnapshot, writeJson, writeText } from '../render.js';
import { closeConnection, connectClientFor } from '../shared/connection.js';
import { normalizeOptions, resolveGlobalOptions } from '../shared/options.js';
import type { GlobalCliOptions } from '../types.js';

/** run/resume 共享同一懒加载 TUI 路径，非交互命令不会加载 React/Ink。 */
export function registerRunCommands(program: Command): void {
  program
    .command('run [prompt...]')
    .description('start a thread turn')
    .option('--thread <threadId>')
    .option('--model <model>')
    .option('--profile <profile>')
    .option(
      '--mode <mode>',
      'ask-before-changes, accept-edits, plan, or bypass',
    )
    .option('--json')
    .option('--no-tui')
    .action(
      async (
        promptParts: readonly string[],
        commandOptions: unknown,
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        await runPrompt(promptParts.join(' ').trim(), {
          ...global,
          ...normalizeOptions(commandOptions),
        });
      },
    );

  program
    .command('resume [threadId]')
    .description('resume a thread')
    .option('--all', 'select the most recent thread from every directory')
    .option('--json')
    .option('--no-tui')
    .action(
      async (
        threadId: string | undefined,
        commandOptions: {
          readonly all?: boolean;
          readonly json?: boolean;
          readonly tui?: boolean;
        },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const connection = await connectClientFor(global);
        try {
          const id =
            threadId ??
            (
              await connection.client.request('thread/list', {
                archived: false,
                ...(commandOptions.all === true
                  ? {}
                  : { cwd: global.root ?? process.cwd() }),
                limit: 1,
              })
            ).data[0]?.id;
          if (id === undefined) {
            throw new Error('No active thread is available to resume.');
          }
          const snapshot = await connection.client.request('thread/resume', {
            threadId: id,
            subscribe: true,
          });
          if (global.json === true || commandOptions.json === true) {
            writeJson(snapshot);
          } else if (
            global.noTui === true ||
            commandOptions.tui === false ||
            !process.stdout.isTTY
          ) {
            renderSnapshot(snapshot);
          } else {
            await renderThreadTui(
              createThreadClient({ server: connection.client, snapshot }),
            );
          }
        } finally {
          await closeConnection(connection.client);
        }
      },
    );
}

/** 执行交互与非交互 Turn；TUI 渲染只在命令真正进入交互路径时加载。 */
export async function runPrompt(
  prompt: string,
  options: GlobalCliOptions & {
    thread?: string;
    model?: string;
    profile?: string;
    mode?: string;
  },
): Promise<void> {
  if (prompt === '') {
    if (options.noTui === true && !process.stdout.isTTY)
      throw new Error('run requires a prompt in non-interactive mode.');
    const connection = await connectClientFor(options);
    try {
      const snapshot =
        options.thread === undefined
          ? await connection.client.request('thread/start', {
              cwd: options.root ?? process.cwd(),
              subscribe: true,
            })
          : await connection.client.request('thread/resume', {
              threadId: options.thread,
              subscribe: true,
            });
      await renderThreadTui(
        createThreadClient({ server: connection.client, snapshot }),
      );
    } finally {
      await closeConnection(connection.client);
    }
    return;
  }
  const connection = await connectClientFor(options);
  try {
    const snapshot =
      options.thread === undefined
        ? await connection.client.request('thread/start', {
            cwd: options.root ?? process.cwd(),
            subscribe: true,
          })
        : await connection.client.request('thread/resume', {
            threadId: options.thread,
            subscribe: true,
          });
    const thread = createThreadClient({ server: connection.client, snapshot });
    const notifications: ServerNotification[] = [];
    const stop = connection.client.onNotification((notification) => {
      notifications.push(notification);
      if (options.json === true) writeJson(notification);
    });
    if (options.model !== undefined) await thread.setModel(options.model);
    if (options.profile !== undefined) await thread.setProfile(options.profile);
    if (options.mode !== undefined) {
      await thread.setMode(parseMode(options.mode));
    }
    const turnId = await thread.submit(prompt);
    if (options.json !== true) writeText(`turn ${turnId}`);
    await waitForTurn(connection.client, thread.threadId, turnId);
    stop();
    if (options.json !== true) renderSnapshot(thread.snapshot);
    void notifications;
  } finally {
    await closeConnection(connection.client);
  }
}

function parseMode(
  value: string,
): import('../../api/protocol-types.js').SessionMode {
  if (
    value === 'ask-before-changes' ||
    value === 'plan' ||
    value === 'accept-edits' ||
    value === 'bypass'
  ) {
    return value;
  }
  throw new Error(`Unsupported mode ${value}.`);
}

async function waitForTurn(
  client: AppServerClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pending: { timeout?: NodeJS.Timeout } = {};
    let stop = (): void => undefined;
    let settled = false;
    const settle = (result: { readonly error?: Error }): void => {
      if (settled) return;
      settled = true;
      stop();
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      if (result.error === undefined) resolve();
      else reject(result.error);
    };
    stop = client.onNotification((notification) => {
      if (
        notification.method !== 'turn/completed' ||
        notification.params.threadId !== threadId ||
        notification.params.turnId !== turnId
      ) {
        return;
      }
      const turn = notification.params.turn;
      if (turn.status === 'completed') {
        settle({});
        return;
      }
      if (turn.status === 'interrupted') {
        settle({ error: new Error(`Turn ${turnId} was interrupted.`) });
        return;
      }
      if (turn.status === 'failed') {
        const errorItem = [...turn.items]
          .reverse()
          .find((item) => item.type === 'error');
        const detail =
          errorItem === undefined
            ? turn.errorCode
            : `${errorItem.code}: ${errorItem.message}`;
        settle({
          error: new Error(
            `Turn ${turnId} failed${detail === undefined ? '.' : ` (${detail}).`}`,
          ),
        });
        return;
      }
      settle({
        error: new Error(
          `Turn ${turnId} emitted a terminal notification with status ${turn.status}.`,
        ),
      });
    });
    if (settled) {
      stop();
      return;
    }
    pending.timeout = setTimeout(
      () => {
        settle({
          error: new Error(
            `Turn ${turnId} did not complete before the client timeout.`,
          ),
        });
      },
      24 * 60 * 60 * 1000,
    );
    pending.timeout.unref();
  });
}

async function renderThreadTui(
  thread: ReturnType<typeof createThreadClient>,
): Promise<void> {
  const { renderTui } = await import('../../tui/index.js');
  await renderTui(thread);
}
