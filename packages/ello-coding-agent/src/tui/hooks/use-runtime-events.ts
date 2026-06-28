import { useEffect, useReducer } from 'react';

import type { CodingSession } from '../../runtime/coding-session.js';
import {
  initialViewState,
  reduce,
  type ViewInput,
  type ViewState,
} from '../state/view-reducer.js';

/**
 * 订阅 {@link CodingSession} 事件并折叠成视图状态。
 *
 * 保留旧名 `useRuntimeEvents`，但内部已换成共享运行时：用 `useReducer` 承接
 * {@link reduce}，把每条 `CodingSessionEvent` 喂进去；额外返回一个 `pushUser`
 * 让 App 在提交时把用户输入即时落到 transcript。
 */
export function useRuntimeEvents(session: CodingSession): {
  readonly state: ViewState;
  pushUser(text: string): void;
} {
  const [state, dispatch] = useReducer(reduce, initialViewState);

  useEffect(
    () => session.subscribe((event) => dispatch(event as ViewInput)),
    [session],
  );

  return {
    state,
    pushUser: (text: string) => dispatch({ type: 'user.input', text }),
  };
}
