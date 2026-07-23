import { cycleSessionMode } from '@ello/agent/protocol';
import { ArrowUp, Folder, Paperclip, Square, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';


import {
  flushQueue,
  selectComposerAttachments,
  selectComposerQueue,
  submitComposer,
  useComposerStore,
} from '../composer';

import { ModelPicker } from './ModelPicker';
import { ModeSwitcher } from './ModeSwitcher';

import { IconButton } from '@/components/ui/IconButton';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  interruptActiveTurn,
  setThreadMode,
} from '@/features/thread';
import { cn } from '@/lib/cn';
import { runOperation } from '@/lib/report';
import { pickFiles } from '@/lib/tauri/bridge';
import {
  useAppStore,
  useClearComposerPrefill,
  useSelectedSnapshot,
  useSelectedThread,
} from '@/store/store';


/**
 * 输入区四层结构:附件条 / 编辑器 / ActionBar / ControlBar。
 * 发送键黑白反转(open-webui),生成中同位变停止键。
 */
export function Composer() {
  const thread = useSelectedThread();
  const snapshot = useSelectedSnapshot();
  const connected = useAppStore((s) => s.connection.phase === 'ready');
  const enterToSend = useAppStore((s) => s.preferences.enterToSend);
  const prefill = useAppStore((s) => s.view.composerPrefill);
  const clearComposerPrefill = useClearComposerPrefill();

  const threadId = thread?.id;
  const draft = useComposerStore((s) =>
    threadId === undefined ? '' : (s.drafts[threadId] ?? ''),
  );
  const attachments = useComposerStore((s) =>
    selectComposerAttachments(s, threadId),
  );
  const queued = useComposerStore((s) => selectComposerQueue(s, threadId));
  const setDraft = useComposerStore((s) => s.setDraft);
  const setAttachments = useComposerStore((s) => s.setAttachments);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running =
    snapshot?.turns.some((turn) => turn.status === 'inProgress') === true;
  const settings = snapshot?.settings;

  // 预填投递(引导卡等入口):写入草稿并聚焦。
  useEffect(() => {
    if (prefill === null || threadId === undefined) return;
    setDraft(threadId, prefill.text);
    clearComposerPrefill();
    textareaRef.current?.focus();
  }, [clearComposerPrefill, prefill, threadId, setDraft]);

  // 回合结束 → 冲刷排队消息。
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;
    if (wasRunning && !running && threadId !== undefined) {
      void runOperation(flushQueue(threadId));
    }
  }, [running, threadId]);

  // 自适应高度(1–10 行)。
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  }, [draft]);

  const submit = useCallback(() => {
    if (threadId === undefined) return;
    void runOperation(submitComposer(threadId));
  }, [threadId]);

  if (threadId === undefined || thread === undefined) {
    return null;
  }

  const canType = connected;
  const canSend =
    canType &&
    (draft.trim() !== '' ||
      (attachments !== undefined && attachments.length > 0));

  const cycleMode = () => {
    if (settings === undefined) return;
    void runOperation(
      setThreadMode(threadId, cycleSessionMode(settings.mode, true)),
    );
  };

  const placeholder = !connected
    ? '连接已断开…'
    : running
      ? 'ello 正在工作,继续输入将排队…'
      : '描述你想要的更改…';

  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      <div className="mx-auto max-w-3xl">
        {queued !== undefined && queued.length > 0 && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-tertiary">
            <span className="rounded-full bg-fluent-subtle px-2 py-0.5 text-fluent">
              已排队 {queued.length} 条
            </span>
            <span className="truncate">{queued[0]?.preview}</span>
          </div>
        )}
        <div
          className={cn(
            'rounded-xl border border-border-default bg-surface-1 shadow-card',
            'transition-colors duration-150 focus-within:border-card-border-accent',
            !canType && 'opacity-70',
          )}
        >
          {attachments !== undefined && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
              {attachments.map((file) => (
                <span
                  key={file.path}
                  className="flex h-6 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 pr-1 pl-2 text-[11px] text-secondary"
                >
                  <Paperclip size={10} className="text-tertiary" />
                  <span className="max-w-40 truncate font-mono">{file.displayName}</span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${file.displayName}`}
                    onClick={() =>
                      setAttachments(
                        threadId,
                        attachments.filter((f) => f.path !== file.path),
                      )
                    }
                    className="cursor-pointer rounded p-0.5 text-tertiary hover:text-danger"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={draft}
            disabled={!canType}
            onChange={(event) => setDraft(threadId, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault();
                cycleMode();
                return;
              }
              if (event.key === 'Escape' && draft !== '') {
                event.preventDefault();
                setDraft(threadId, '');
                return;
              }
              if (event.key === 'Enter') {
                const shouldSend = enterToSend ? !event.shiftKey : event.metaKey;
                if (shouldSend && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }
            }}
            placeholder={placeholder}
            rows={2}
            className={cn(
              'block max-h-[220px] min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1',
              'text-[13.5px] leading-6 text-primary outline-none placeholder:text-disabled',
            )}
          />

          <div className="flex items-center gap-1 px-2 pb-1.5">
            <IconButton
              icon={<Paperclip size={15} />}
              tooltip="添加文件"
              size={28}
              disabled={!canType}
              onClick={() =>
                void runOperation(
                  pickFiles('选择要附加的文件').then((paths) => {
                    if (paths.length === 0) return;
                    const selected = paths.map((path) => ({
                      path,
                      displayName: path.split('/').pop() ?? path,
                    }));
                    setAttachments(
                      threadId,
                      attachments === undefined
                        ? selected
                        : [...attachments, ...selected],
                    );
                  }),
                )
              }
            />
            <div className="flex-1" />
            {settings !== undefined && (
              <ModelPicker
                threadId={threadId}
                cwd={thread.cwd}
                model={settings.model}
                disabled={!connected}
              />
            )}
            {running ? (
              <Tooltip content="停止生成">
                <button
                  type="button"
                  aria-label="停止生成"
                  onClick={() => void runOperation(interruptActiveTurn(threadId))}
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-neutral-900 text-white transition-colors duration-150 hover:bg-danger dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-danger dark:hover:text-white"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="发送 (⌘Enter)">
                <button
                  type="button"
                  aria-label="发送"
                  disabled={!canSend}
                  onClick={submit}
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full transition-all duration-150',
                    canSend
                      ? 'cursor-pointer bg-neutral-900 text-white hover:opacity-85 dark:bg-neutral-100 dark:text-neutral-900'
                      : 'cursor-not-allowed bg-surface-3 text-disabled',
                  )}
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              </Tooltip>
            )}
          </div>

          <div className="flex h-7 items-center gap-3 border-t border-border-subtle px-3 text-[11px] text-tertiary">
            <span className="flex min-w-0 items-center gap-1 font-mono">
              <Folder size={10} className="shrink-0" />
              <span className="truncate">{thread.cwd}</span>
            </span>
            <div className="flex-1" />
            {settings !== undefined && (
              <ModeSwitcher
                threadId={threadId}
                mode={settings.mode}
                disabled={!connected}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
