import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { CodingSession } from '../../runtime/coding-session.js';
import {
  initialTuiEventState,
  reduceTuiEvent,
  type TuiEventInput,
  type TuiEventState,
} from '../store/tui-event-store.js';

export function useRuntimeEvents(session: CodingSession): {
  readonly state: TuiEventState;
  readonly clearCount: number;
  readonly historyResetKey: number;
  pushUser(text: string): void;
} {
  const [state, dispatch] = useReducer(reduceTuiEvent, initialTuiEventState);
  const [clearCount, setClearCount] = useState(0);
  const [historyResetKey, setHistoryResetKey] = useState(0);
  const runStartedAt = useRef<number | undefined>(undefined);

  useEffect(
    () =>
      session.subscribe((event) => {
        if (event.type === 'ui.clear') {
          clearTerminalScrollback();
          setClearCount((current) => current + 1);
          setHistoryResetKey((current) => current + 1);
        }
        if (event.type === 'session.history.loaded') {
          clearTerminalScrollback();
          setHistoryResetKey((current) => current + 1);
        }
        if (event.type === 'run.started') {
          runStartedAt.current = Date.now();
        }
        dispatch(event as TuiEventInput);
        if (
          isRunFinishedEvent(event.type) &&
          runStartedAt.current !== undefined
        ) {
          const elapsedSeconds = Math.max(
            0,
            Math.floor((Date.now() - runStartedAt.current) / 1000),
          );
          runStartedAt.current = undefined;
          dispatch({
            type: 'run.worked',
            duration: formatRunDuration(elapsedSeconds),
          });
        }
      }),
    [session],
  );

  const pushUser = useCallback(
    (text: string) => dispatch({ type: 'user.input', text }),
    [],
  );

  return {
    state,
    clearCount,
    historyResetKey,
    pushUser,
  };
}

function clearTerminalScrollback(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function isRunFinishedEvent(type: string): boolean {
  return (
    type === 'run.completed' ||
    type === 'run.failed' ||
    type === 'run.interrupted' ||
    type === 'ui.interrupted'
  );
}

function formatRunDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
