import { useCallback, useEffect, useReducer, useState } from 'react';

import type { UserInputResolution } from '../../api/protocol-types.js';
import { ThreadClient } from '../../client/thread-client.js';
import {
  createInitialTuiEventState,
  reduceTuiEvent,
  type TuiEventInput,
  type TuiEventState,
} from '../store/tui-event-store.js';

export function useRuntimeEvents(thread: ThreadClient): {
  readonly state: TuiEventState;
  readonly historyResetKey: number;
  readonly workingSeconds: number | undefined;
  dispatch(event: TuiEventInput): void;
  queueSteer(text: string): void;
  resolveInteraction(requestId: string, resolution?: UserInputResolution): void;
} {
  const [state, dispatch] = useReducer(
    reduceTuiEvent,
    thread.snapshot,
    (snapshot) => createInitialTuiEventState(snapshot),
  );
  const [workingClock, setWorkingClock] = useState<{
    readonly runStartedAt: number;
    readonly seconds: number;
  }>();

  useEffect(() => thread.subscribe((event) => {
    if (event.type === 'snapshot') clearTerminalScrollback();
    dispatch(event);
  }), [thread]);

  useEffect(() => {
    const runStartedAt = state.runStartedAt;
    if (runStartedAt === undefined) return;
    const timer = setInterval(() => {
      setWorkingClock({
        runStartedAt,
        seconds: Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000)),
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [state.runStartedAt]);

  const queueSteer = useCallback((text: string) => {
    dispatch({ type: 'steer.queued', text });
  }, []);
  const resolveInteraction = useCallback((requestId: string, resolution?: UserInputResolution) => {
    dispatch({
      type: 'interaction.resolved',
      requestId,
      ...(resolution === undefined ? {} : { resolution }),
    });
  }, []);

  return {
    state,
    historyResetKey: state.historyResetKey,
    workingSeconds:
      state.runStartedAt === undefined
        ? undefined
        : workingClock?.runStartedAt === state.runStartedAt
          ? workingClock.seconds
          : 0,
    dispatch,
    queueSteer,
    resolveInteraction,
  };
}

function clearTerminalScrollback(): void {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}
