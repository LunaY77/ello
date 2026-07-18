import { connectClient, type ClientConnection, type ClientConnectionOptions } from './connection.js';

export function createRemoteServerClient(endpoint: string, options: Omit<ClientConnectionOptions, 'endpoint'> = {}): Promise<ClientConnection> {
  return connectClient({ ...options, endpoint });
}
