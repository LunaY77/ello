import type {
  ServerNotification,
  ThreadSnapshot,
} from '../api/protocol-types.js';
import type { ClientServerRequest } from '../api/server-requests.js';

export type ThreadClientEvent =
  | {
      readonly type: 'notification';
      readonly notification: ServerNotification;
    }
  | {
      readonly type: 'snapshot';
      readonly snapshot: ThreadSnapshot;
    }
  | {
      readonly type: 'serverRequest';
      readonly request: ClientServerRequest;
    }
  | {
      readonly type: 'stale';
      readonly expectedSeq: number;
      readonly receivedSeq: number;
    }
  | {
      readonly type: 'error';
      readonly error: Error;
    };

export type ThreadClientListener = (event: ThreadClientEvent) => void;
