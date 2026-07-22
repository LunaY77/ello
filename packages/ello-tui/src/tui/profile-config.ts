import type { ThreadClient } from '../client/thread-client.js';
import type { LocalUiConfig } from '../config/local-ui-config.js';

import {
  PROFILE_ROLES,
  type ProfileRole,
  type TuiProfile,
} from './profile-types.js';
import type { SettingUpdate, TuiSetting } from './settings/types.js';
import { defaultThemeName, themeNames, type ThemeName } from './theme/index.js';

/** Config 响应在进入 UI state 前完成运行时校验，组件不读取 unknown 属性。 */
export function profilesFromConfig(config: unknown): readonly TuiProfile[] {
  if (!isRecord(config)) throw new Error('Config must be an object.');
  const profiles = config.profile;
  if (!isRecord(profiles)) throw new Error('Config has no profile map.');
  return Object.entries(profiles).map(([name, value]) =>
    parseProfile(name, value),
  );
}

export function activeProfileFromConfig(config: unknown): string {
  if (!isRecord(config)) throw new Error('Config must be an object.');
  const activeProfile = config.active_profile;
  if (typeof activeProfile !== 'string' || activeProfile.length === 0) {
    throw new Error('Config has no active_profile.');
  }
  return activeProfile;
}

export function bypassEnabledFromConfig(config: unknown): boolean {
  if (!isRecord(config)) throw new Error('Config must be an object.');
  const bypassEnabled = config.bypass_enabled;
  if (typeof bypassEnabled !== 'boolean') {
    throw new Error('Config has no bypass_enabled boolean.');
  }
  return bypassEnabled;
}

export function profileRoleOptions(profile: TuiProfile) {
  return PROFILE_ROLES.map((role) => ({
    value: role,
    label: `${role.padEnd(8)} ${profile.models[role]}`,
  }));
}

export async function loadSettings(
  thread: ThreadClient,
  local: LocalUiConfig,
): Promise<readonly TuiSetting[]> {
  const server = await thread.request('config/settings', { cwd: thread.cwd });
  return [
    {
      owner: 'client',
      id: 'appearance.theme',
      path: ['theme'],
      label: 'Theme',
      description: 'Color theme used by the terminal interface.',
      group: 'Appearance',
      type: 'enum',
      value: local.theme,
      source: 'global',
      writableScopes: ['global'],
      effect: 'immediate',
      options: themeNames,
      sensitive: false,
    },
    {
      owner: 'client',
      id: 'input.keymap',
      path: ['keymap'],
      label: 'Keymap',
      description: 'Local TUI key bindings as a JSON object.',
      group: 'Input',
      type: 'json',
      value: local.keymap,
      source: 'global',
      writableScopes: ['global'],
      effect: 'restart',
      sensitive: false,
    },
    ...server.data.map(
      (setting): TuiSetting => ({ ...setting, owner: 'server' }),
    ),
  ];
}

export function updatedLocalUiConfig(
  current: LocalUiConfig,
  update: SettingUpdate,
): LocalUiConfig {
  if (update.setting.path[0] === 'theme') {
    const theme =
      update.operation === 'delete' ? defaultThemeName : update.value;
    if (!isThemeName(theme)) {
      throw new Error(`Unknown theme: ${String(theme)}`);
    }
    return { ...current, theme };
  }
  if (update.setting.path[0] === 'keymap') {
    const keymap = update.operation === 'delete' ? {} : update.value;
    if (!isStringRecord(keymap)) {
      throw new Error('Keymap must be a JSON object with string values.');
    }
    return { ...current, keymap };
  }
  throw new Error(`Unknown local setting ${update.setting.id}.`);
}

function parseProfile(name: string, value: unknown): TuiProfile {
  if (!isRecord(value)) throw new Error(`Profile ${name} is not an object.`);
  const models = value.models;
  if (!isRecord(models)) {
    throw new Error(`Profile ${name} has no model bindings.`);
  }
  const parsedModels = Object.fromEntries(
    PROFILE_ROLES.map((role) => [role, readModel(name, models, role)]),
  );
  if (!isProfileModels(parsedModels)) {
    throw new Error(`Profile ${name} has invalid model bindings.`);
  }
  return {
    id: name,
    name,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    models: parsedModels,
    raw: value,
  };
}

function readModel(
  profile: string,
  bindings: Record<string, unknown>,
  role: ProfileRole,
): string {
  const model = bindings[role];
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`Profile ${profile} has no ${role} model.`);
  }
  return model;
}

function isProfileModels(
  value: Record<string, string>,
): value is Record<ProfileRole, string> {
  return PROFILE_ROLES.every((role) => value[role] !== undefined);
}

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && themeNames.some((name) => name === value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
