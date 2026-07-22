import { relative } from 'node:path';

import { useEffect, useMemo, useRef, useState } from 'react';

import { isToolItem } from '../../api/protocol-types.js';
import type { UserInput } from '../../api/protocol-types.js';
import type { ThreadClient } from '../../client/thread-client.js';
import type { TuiEventState } from '../store/tui-event-store.js';

import type { useRuntimeEvents } from './use-runtime-events.js';

type Dispatch = ReturnType<typeof useRuntimeEvents>['dispatch'];

/** 提交状态保留原输入直到出现可见 Agent trace，Ctrl+C 才能准确恢复草稿。 */
export function useSubmission(input: {
  readonly thread: ThreadClient;
  readonly state: TuiEventState;
  readonly running: boolean;
  readonly draft: string;
  readonly dispatch: Dispatch;
  queueSteer(text: string): void;
  setDraft(value: string): void;
  onError(error: unknown): void;
}) {
  const [submittedInputs, setSubmittedInputs] = useState<readonly string[]>([]);
  const [submissionPending, setSubmissionPending] = useState(false);
  const pendingSubmittedInput = useRef<
    | {
        readonly value: string;
        readonly turnId?: string;
        readonly interruptRequested?: boolean;
      }
    | undefined
  >(undefined);
  const activeTurn = input.state.snapshot.turns.find(
    (turn) => turn.id === input.state.activeTurnId,
  );
  const activeTurnHasAgentTrace =
    activeTurn?.items.some(isCompletedRenderableTrace) ?? false;
  const inputHistory = useMemo(
    () =>
      mergeInputHistory(
        input.state.history.flatMap((entry) =>
          entry.kind === 'user' ? [entry.text] : [],
        ),
        submittedInputs,
      ),
    [input.state.history, submittedInputs],
  );

  useEffect(() => {
    const pending = pendingSubmittedInput.current;
    if (pending === undefined) return;
    if (activeTurnHasAgentTrace) {
      pendingSubmittedInput.current = undefined;
      return;
    }
    if (
      pending.turnId !== undefined &&
      input.state.activeTurnId !== undefined &&
      input.state.activeTurnId !== pending.turnId
    ) {
      pendingSubmittedInput.current = undefined;
      return;
    }
    const submittedTurn = input.state.snapshot.turns.find(
      (turn) => turn.id === pending.turnId,
    );
    if (submittedTurn !== undefined && submittedTurn.status !== 'inProgress') {
      pendingSubmittedInput.current = undefined;
    }
  }, [
    activeTurnHasAgentTrace,
    input.state.activeTurnId,
    input.state.snapshot.turns,
  ]);

  const submitText = async (value: string): Promise<void> => {
    if (input.running) {
      const userInput = await resolveUserInput(input.thread, value);
      input.queueSteer(value);
      await input.thread.steerInput(userInput);
      return;
    }
    pendingSubmittedInput.current = { value };
    setSubmissionPending(true);
    try {
      const userInput = await resolveUserInput(input.thread, value);
      const turnId = await input.thread.submitInput(userInput);
      setSubmissionPending(false);
      const pending = pendingSubmittedInput.current;
      if (pending?.value !== value) return;
      if (pending.interruptRequested === true) {
        pendingSubmittedInput.current = undefined;
        await input.thread.interrupt('user cancelled');
      } else {
        pendingSubmittedInput.current = { value, turnId };
      }
    } catch (error) {
      if (pendingSubmittedInput.current?.value === value) {
        pendingSubmittedInput.current = undefined;
      }
      setSubmissionPending(false);
      throw error;
    }
  };

  const rememberInput = (value: string): void => {
    if (value.trim() === '') return;
    setSubmittedInputs((current) => mergeInputHistory(current, [value]));
  };

  const cancel = (): boolean => {
    const pending = pendingSubmittedInput.current;
    const interrupts = input.running || submissionPending;
    if (!interrupts && pending === undefined && input.draft !== '') {
      input.setDraft('');
      return true;
    }
    if (!interrupts && pending === undefined) return false;
    if (
      pending !== undefined &&
      !activeTurnHasAgentTrace &&
      (pending.turnId === undefined ||
        input.state.activeTurnId === undefined ||
        pending.turnId === input.state.activeTurnId)
    ) {
      input.setDraft(pending.value);
    }
    if (pending !== undefined && pending.turnId === undefined) {
      pendingSubmittedInput.current = { ...pending, interruptRequested: true };
    } else {
      pendingSubmittedInput.current = undefined;
      setSubmissionPending(false);
      void input.thread.interrupt('user cancelled').catch(input.onError);
    }
    return true;
  };

  return {
    submissionPending,
    inputHistory,
    submitText,
    rememberInput,
    cancel,
  };
}

function mergeInputHistory(
  ...groups: readonly (readonly string[])[]
): readonly string[] {
  const values: string[] = [];
  for (const group of groups) {
    for (const value of group) {
      if (value.trim() === '') continue;
      const previous = values.indexOf(value);
      if (previous !== -1) values.splice(previous, 1);
      values.push(value);
    }
  }
  return values.slice(-50);
}

function isCompletedRenderableTrace(
  item: TuiEventState['snapshot']['turns'][number]['items'][number],
): boolean {
  if (item.type === 'agentMessage' || item.type === 'plan') {
    return item.status === 'completed' && item.text.trim() !== '';
  }
  return isToolItem(item) && item.status !== 'inProgress';
}

async function resolveUserInput(
  thread: ThreadClient,
  value: string,
): Promise<readonly UserInput[]> {
  const matches = [...value.matchAll(/(^|\s)@([^\s]+)/gu)];
  if (matches.length === 0) return [{ type: 'text', text: value }];
  const files: UserInput[] = [];
  const resolvedPaths = new Set<string>();
  let text = value;
  for (const match of matches) {
    const query = match[2];
    if (query === undefined) continue;
    const result = await thread.request('fs/search', {
      cwd: thread.cwd,
      query,
      kind: 'any',
      limit: 50,
    });
    const found = result.data.find(
      (entry) => entry.path.endsWith(`/${query}`) || entry.name === query,
    );
    if (found === undefined) continue;
    text = text.replace(match[0], '');
    if (resolvedPaths.has(found.path)) continue;
    resolvedPaths.add(found.path);
    files.push({
      type: 'file',
      path: found.path,
      displayName: displayFilePath(found.path, thread.cwd),
    });
  }
  return text.trim() === ''
    ? files
    : [{ type: 'text', text: text.trim() }, ...files];
}

function displayFilePath(filePath: string, cwd: string): string {
  const result = relative(cwd, filePath);
  return result === '' ? '.' : result;
}
