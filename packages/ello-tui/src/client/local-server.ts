import {
  connectClient,
  type ClientConnection,
  type ClientConnectionOptions,
} from './connection.js';

export function createLocalServerClient(
  options: Omit<ClientConnectionOptions, 'endpoint' | 'authToken'> = {},
): Promise<ClientConnection> {
  return connectClient({ ...options, endpoint: 'stdio://' });
}
