import type { CodingAgentController } from '@ello/coding-agent';
import { useEffect } from 'react';
import type { Dispatch } from 'react';


import type { TuiAction } from '../state/index.js';

/**
 * 订阅活跃 coding-agent 会话，并将事件转发到 TUI 状态。
 */
export function useSessionEvents(
  controller: CodingAgentController,
  dispatch: Dispatch<TuiAction>,
): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const sessions = await controller.listSessions();
      if (!cancelled) {
        dispatch({ type: 'sessions', sessions });
        dispatch({ type: 'models', models: controller.listModels() });
      }
      for await (const event of controller.session.events()) {
        if (cancelled) {
          break;
        }
        dispatch({ type: 'event', event });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controller, dispatch]);
}
