import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

interface Cursor {
  readonly line: number;
  readonly column: number;
}

interface FileSearch {
  readonly query: string;
  readonly suggestions: readonly string[];
}

/** 管理编辑器文本、光标和文件候选的本地状态，不触碰 Thread runtime。 */
export function useComposerState(initialDraft: string): {
  readonly draft: string;
  readonly setDraft: Dispatch<SetStateAction<string>>;
  readonly cursor: Cursor;
  readonly setCursor: Dispatch<SetStateAction<Cursor>>;
  readonly fileSearch: FileSearch | undefined;
  readonly setFileSearch: Dispatch<SetStateAction<FileSearch | undefined>>;
} {
  const [draft, setDraft] = useState(initialDraft);
  const [cursor, setCursor] = useState<Cursor>({ line: 0, column: 0 });
  const [fileSearch, setFileSearch] = useState<FileSearch>();
  return {
    draft,
    setDraft,
    cursor,
    setCursor,
    fileSearch,
    setFileSearch,
  };
}
