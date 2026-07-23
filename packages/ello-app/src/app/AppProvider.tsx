import { useEffect, type ReactNode } from 'react';

import { useThemeEffect } from './TopBarContent';

import { startSession } from '@/client/session';
import { isTauri } from '@/lib/tauri/bridge';


/** composition root:主题副作用 + 会话启动;不承载业务状态机。 */
export function AppProvider(props: { readonly children: ReactNode }) {
  useThemeEffect();

  useEffect(() => {
    if (isTauri()) {
      void startSession();
    }
  }, []);

  return <>{props.children}</>;
}
