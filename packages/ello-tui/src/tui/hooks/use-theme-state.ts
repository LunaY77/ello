import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { loadLocalUiConfig } from '../../config/local-ui-config.js';
import { defaultThemeName, type ThemeName } from '../theme/index.js';

import { clearTerminalScrollback } from './use-runtime-events.js';

/** 读取本地主题并用 epoch 触发终端 scrollback 清理后的重绘。 */
export function useThemeState(onError: (error: unknown) => void): {
  readonly themeName: ThemeName;
  readonly themeEpoch: number;
  readonly setThemeName: (theme: ThemeName) => void;
  readonly setThemeEpoch: Dispatch<SetStateAction<number>>;
} {
  const [themeName, setThemeName] = useState<ThemeName>(defaultThemeName);
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    void loadLocalUiConfig()
      .then((local) => {
        if (local.theme !== themeName) {
          clearTerminalScrollback();
          setThemeEpoch((current) => current + 1);
          setThemeName(local.theme);
        }
      })
      .catch(onError);
  }, [onError, themeName]);
  return { themeName, themeEpoch, setThemeName, setThemeEpoch };
}
