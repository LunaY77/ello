import type { Dispatch, SetStateAction } from 'react';

import type { ThreadClient } from '../../client/thread-client.js';
import {
  loadLocalUiConfig,
  saveLocalUiConfig,
} from '../../config/local-ui-config.js';
import type { OverlayState } from '../component/OverlayHost.js';
import { loadSettings, updatedLocalUiConfig } from '../settings/config.js';
import type { SettingUpdate } from '../settings/types.js';
import { clearTerminalScrollback } from '../terminal-screen.js';
import type { ThemeName } from '../theme/index.js';

export function useSettings(input: {
  readonly thread: ThreadClient;
  readonly themeName: ThemeName;
  setConfig(config: unknown): void;
  setOverlay(overlay: OverlayState): void;
  setThemeName(theme: ThemeName): void;
  setThemeEpoch: Dispatch<SetStateAction<number>>;
}) {
  return {
    updateSetting: async (update: SettingUpdate): Promise<void> => {
      if (update.setting.owner === 'client') {
        const current = await loadLocalUiConfig();
        const next = updatedLocalUiConfig(current, update);
        const previousTheme = input.themeName;
        if (next.theme !== current.theme) {
          // themeEpoch 会重挂 Static 并按新主题重放历史，先清掉旧配色的那一份。
          clearTerminalScrollback();
          input.setThemeEpoch((epoch) => epoch + 1);
          input.setThemeName(next.theme);
        }
        try {
          await saveLocalUiConfig(next);
        } catch (error) {
          input.setThemeName(previousTheme);
          throw error;
        }
      } else {
        const result = await input.thread.request('config/write', {
          cwd: input.thread.cwd,
          source: update.source,
          path: update.setting.path,
          operation: update.operation,
          ...(update.operation === 'set' ? { value: update.value } : {}),
        });
        input.setConfig(result.config);
      }
      const local = await loadLocalUiConfig();
      input.setOverlay({
        type: 'settings',
        settings: await loadSettings(input.thread, local),
      });
    },
  };
}
