import type { ThreadClient } from '../../client/thread-client.js';
import type { LocalUiConfig } from '../../config/local-ui-config.js';
import {
  defaultThemeName,
  themeNames,
  type ThemeName,
} from '../theme/index.js';

import type { SettingUpdate, TuiSetting } from './types.js';

export function bypassEnabledFromConfig(config: unknown): boolean {
  if (!isRecord(config)) throw new Error('Config must be an object.');
  const bypassEnabled = config.bypass_enabled;
  if (typeof bypassEnabled !== 'boolean') {
    throw new Error('Config has no bypass_enabled boolean.');
  }
  return bypassEnabled;
}

export function globalModelSelectionsFromConfig(config: unknown): {
  readonly primaryModel: string;
  readonly auxiliaryModel: string;
} {
  if (!isRecord(config)) throw new Error('Config must be an object.');
  const primaryModel = config.primary_model;
  const auxiliaryModel = config.auxiliary_model;
  if (typeof primaryModel !== 'string' || primaryModel === '') {
    throw new Error('Config has no primary_model.');
  }
  if (typeof auxiliaryModel !== 'string' || auxiliaryModel === '') {
    throw new Error('Config has no auxiliary_model.');
  }
  return { primaryModel, auxiliaryModel };
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
