import type { ClientResult } from '../../api/protocol-types.js';

type ServerSetting = ClientResult<'config/settings'>['data'][number];

export type TuiSetting = ServerSetting & {
  readonly owner: 'client' | 'server';
};

export interface SettingUpdate {
  readonly setting: TuiSetting;
  readonly source: 'global' | 'project';
  readonly operation: 'set' | 'delete';
  readonly value?: unknown;
}
