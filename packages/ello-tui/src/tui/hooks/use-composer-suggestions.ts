import { relative } from 'node:path';

import { useEffect, useMemo } from 'react';

import type { AgentSkill } from '../../api/protocol-types.js';
import type { ThreadClient } from '../../client/thread-client.js';
import { completeInput } from '../completion.js';
import type { TuiProfile } from '../profile-types.js';
import { detectTrigger } from '../store/autocomplete.js';

const NO_FILE_SUGGESTIONS: readonly string[] = [];

/** 文件候选只响应当前光标所在 trigger，过期异步结果不会覆盖新查询。 */
export function useComposerSuggestions(input: {
  readonly thread: ThreadClient;
  readonly draft: string;
  readonly cursor: { readonly line: number; readonly column: number };
  readonly fileSearch:
    | { readonly query: string; readonly suggestions: readonly string[] }
    | undefined;
  readonly profiles: readonly TuiProfile[];
  readonly skills: readonly AgentSkill[];
  setFileSearch(value: {
    readonly query: string;
    readonly suggestions: readonly string[];
  }): void;
  onError(error: unknown): void;
}) {
  const {
    thread,
    draft,
    cursor,
    fileSearch,
    profiles,
    skills,
    setFileSearch,
    onError,
  } = input;
  const activeTrigger = detectTrigger(currentLineBeforeCursor(draft, cursor));
  useEffect(() => {
    if (activeTrigger?.kind !== 'file') return;
    const query = activeTrigger.query;
    let live = true;
    void thread
      .request('fs/search', {
        cwd: thread.cwd,
        query,
        kind: 'any',
        limit: 20,
      })
      .then((result) => {
        if (!live) return;
        setFileSearch({
          query,
          suggestions: result.data.map(
            (entry) => `@${displayFilePath(entry.path, thread.cwd)}`,
          ),
        });
      })
      .catch((error: unknown) => {
        if (live) onError(error);
      });
    return () => {
      live = false;
    };
  }, [
    activeTrigger?.kind,
    activeTrigger?.query,
    onError,
    setFileSearch,
    thread,
  ]);

  const fileSuggestions =
    activeTrigger?.kind === 'file' && fileSearch?.query === activeTrigger.query
      ? fileSearch.suggestions
      : NO_FILE_SUGGESTIONS;
  return useMemo(
    () =>
      completeInput(
        draft,
        profiles.map((profile) => profile.name),
        fileSuggestions,
        skills,
        cursor,
      ),
    [fileSuggestions, cursor, draft, profiles, skills],
  );
}

function currentLineBeforeCursor(
  value: string,
  cursor: { readonly line: number; readonly column: number },
): string {
  const line = value.split('\n')[cursor.line];
  if (line === undefined) {
    throw new Error(`Composer cursor line ${cursor.line} is out of bounds.`);
  }
  return line.slice(0, cursor.column);
}

function displayFilePath(filePath: string, cwd: string): string {
  const result = relative(cwd, filePath);
  return result === '' ? '.' : result;
}
