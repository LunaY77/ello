import {
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  filesCacheKey,
  invalidatePath,
  loadDirectory,
  loadFileContent,
  useFilesCache,
  type DirectoryEntry,
} from '../files';

import { EmptyState } from '@/components/ui/EmptyState';
import { CodeBlock } from '@/components/ui/Markdown';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { useAppStore, useSelectedWorkspace, useSetOpenFile } from '@/store/store';


/**
 * 文件页签:工作区文件树(懒加载)+ 文件预览。
 * 变更标记来自当前会话 turnDiffs 的路径集合。
 */
export function FilesTab() {
  const workspace = useSelectedWorkspace();
  const openFilePath = useAppStore((s) => s.view.openFilePath);
  const changedPaths = useChangedPaths();

  // L3/L11:ello 写入文件后,变更路径的父目录缓存失效,重新展开时拿到新内容。
  const changedSignature = [...changedPaths].sort().join('\n');
  const rootPath = workspace?.rootPath;
  useEffect(() => {
    if (rootPath === undefined || changedSignature === '') return;
    for (const path of changedSignature.split('\n')) {
      invalidatePath(rootPath, path);
    }
  }, [changedSignature, rootPath]);

  if (workspace === undefined) {
    return (
      <EmptyState
        icon={<Folder size={20} />}
        title="未选择工作区"
        description="在侧栏选择一个工作区后,这里显示它的文件树。"
      />
    );
  }
  if (openFilePath !== null) {
    return <FilePreview cwd={workspace.rootPath} path={openFilePath} />;
  }
  return <FileTree rootPath={workspace.rootPath} />;
}

function FileTree(props: { readonly rootPath: string }) {
  const { rootPath } = props;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-1">
      <TreeLevel cwd={rootPath} path="." depth={0} rootPath={rootPath} />
    </div>
  );
}

function TreeLevel(props: {
  readonly cwd: string;
  readonly path: string;
  readonly depth: number;
  readonly rootPath: string;
}) {
  const { cwd, path, depth, rootPath } = props;
  const key = filesCacheKey(cwd, path);
  const entries = useFilesCache((s) => s.directories[key]);

  useEffect(() => {
    if (entries === undefined) {
      void runOperation(loadDirectory(cwd, path));
    }
  }, [cwd, path, entries]);

  if (entries === undefined) {
    return (
      <div className="flex h-8 items-center gap-2 px-3" style={{ paddingLeft: depth * 14 + 12 }}>
        <Spinner size={12} />
      </div>
    );
  }
  return (
    <>
      {entries
        .filter((entry) => !entry.name.startsWith('.') || depth > 0)
        .map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            cwd={cwd}
            depth={depth}
            rootPath={rootPath}
          />
        ))}
    </>
  );
}

function TreeNode(props: {
  readonly entry: DirectoryEntry;
  readonly cwd: string;
  readonly depth: number;
  readonly rootPath: string;
}) {
  const setOpenFile = useSetOpenFile();
  const { entry, cwd, depth, rootPath } = props;
  const [expanded, setExpanded] = useState(false);
  const changedPaths = useChangedPaths();
  const isDirectory = entry.kind === 'directory';
  const changed = changedPaths.has(entry.path) || changedPaths.has(entry.name);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (isDirectory) {
            setExpanded((v) => !v);
            if (!expanded) void runOperation(loadDirectory(cwd, entry.path));
          } else {
            setOpenFile(entry.path);
          }
        }}
        style={{ paddingLeft: depth * 14 + 8 }}
        className={cn(
          'flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 text-left text-[12.5px]',
          'transition-colors duration-150 hover:bg-sidebar-hover',
          changed ? 'text-fluent' : 'text-secondary',
        )}
      >
        {isDirectory ? (
          <>
            <ChevronRight
              size={11}
              className={cn('shrink-0 text-tertiary transition-transform duration-200', expanded && 'rotate-90')}
            />
            {expanded ? (
              <FolderOpen size={13} className="shrink-0 text-kind-feature" />
            ) : (
              <Folder size={13} className="shrink-0 text-kind-feature" />
            )}
          </>
        ) : (
          <>
            <span className="w-[11px] shrink-0" />
            <FileCode2 size={13} className="shrink-0 text-tertiary" />
          </>
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {changed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fluent" />}
      </button>
      {isDirectory && expanded && (
        <TreeLevel cwd={cwd} path={entry.path} depth={depth + 1} rootPath={rootPath} />
      )}
    </>
  );
}

/** 当前会话改动过的路径集合(turnDiffs + fileChange items),引用稳定。 */
function useChangedPaths(): ReadonlySet<string> {
  const snapshot = useAppStore((s) => {
    const id = s.view.selectedThreadId;
    return id === null ? undefined : s.entities.snapshots[id];
  });
  const turnDiffs = useAppStore((s) => s.entities.turnDiffs);
  return useMemo(() => {
    const paths = new Set<string>();
    if (snapshot === undefined) return paths;
    for (const turn of snapshot.turns) {
      const diff = turnDiffs[turn.id];
      if (diff !== undefined) {
        for (const change of diff) paths.add(change.path);
      }
      for (const item of turn.items) {
        if (item.type === 'fileChange') {
          for (const change of item.changes) paths.add(change.path);
        }
      }
    }
    return paths;
  }, [snapshot, turnDiffs]);
}

function FilePreview(props: { readonly cwd: string; readonly path: string }) {
  const { cwd, path } = props;
  const setOpenFile = useSetOpenFile();
  const key = filesCacheKey(cwd, path);
  const content = useFilesCache((s) => s.files[key]);

  useEffect(() => {
    if (content === undefined) {
      void runOperation(loadFileContent(cwd, path));
    }
  }, [cwd, path, content]);

  const language = path.includes('.') ? path.split('.').pop() : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-secondary">
          {path}
        </span>
        <button
          type="button"
          aria-label="关闭预览"
          onClick={() => setOpenFile(null)}
          className="cursor-pointer rounded p-1 text-tertiary hover:bg-surface-3 hover:text-primary"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {content === undefined ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : (
          <CodeBlock code={content} language={language} className="my-0" />
        )}
      </div>
    </div>
  );
}
