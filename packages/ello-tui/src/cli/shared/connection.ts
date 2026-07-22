import { connectClient } from '../../client/connection.js';
import { authTokenFromOptions, type GlobalCliOptions } from '../types.js';

/** 连接模块只负责 transport 生命周期，不承载具体命令语义。 */
export async function connectClientFor(options: GlobalCliOptions) {
  const authToken = authTokenFromOptions(options);
  return connectClient({
    ...(options.remote === undefined ? {} : { endpoint: options.remote }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(authToken === undefined ? {} : { authToken }),
    ...(options.timeout === undefined
      ? {}
      : { requestTimeoutMs: options.timeout }),
  });
}

export async function closeConnection(
  client: import('../../api/client.js').AppServerClient,
): Promise<void> {
  await client.close();
}

export async function firstThreadId(
  options: GlobalCliOptions,
): Promise<string | undefined> {
  const connection = await connectClientFor(options);
  try {
    return (
      await connection.client.request('thread/list', {
        archived: false,
        limit: 1,
      })
    ).data[0]?.id;
  } finally {
    await closeConnection(connection.client);
  }
}
