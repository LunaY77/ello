import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { TimelineEmpty } from './TimelineEmpty';
import { TurnView } from './TurnView';

import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/cn';
import { useAppStore, useSelectedSnapshot } from '@/store/store';
import type { ThreadSnapshot } from '@/store/types';


/**
 * 消息时间线:内容列 max-w-3xl 居中。
 * 新内容到达时若用户在底部则自动跟随;向上翻阅后出现"回到底部"悬浮钮。
 */
export function ChatTimeline() {
  const snapshot = useSelectedSnapshot();
  const hasThread = useAppStore((s) => s.view.selectedThreadId !== null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [seenCount, setSeenCount] = useState(0);

  const threadId = snapshot?.thread.id;
  const itemCount = snapshot?.turns.reduce((n, turn) => n + turn.items.length, 0) ?? 0;
  const lastTextLength = lastTextLen(snapshot);

  // 会话切换与跟随态下的已读位置都是 render 期同步派生,不开额外 render 周期。
  const [prevThreadId, setPrevThreadId] = useState(threadId);
  if (threadId !== prevThreadId) {
    setPrevThreadId(threadId);
    setFollowing(true);
    setSeenCount(itemCount);
  } else if (following && seenCount !== itemCount) {
    setSeenCount(itemCount);
  }
  const unread = itemCount - seenCount;

  // 内容增长时跟随底部(仅当用户未上翻);纯 DOM 副作用。
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || !following) return;
    container.scrollTop = container.scrollHeight;
  }, [itemCount, lastTextLength, threadId, following]);

  if (!hasThread) {
    return <TimelineEmpty variant="no-thread" />;
  }
  if (snapshot === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  if (snapshot.turns.length === 0) {
    return <TimelineEmpty variant="empty-thread" />;
  }

  const activeTurnId = snapshot.turns.findLast(
    (turn) => turn.status === 'inProgress',
  )?.id;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setFollowing(atBottom);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-6 py-6">
          {snapshot.turns.map((turn, index) => (
            <div key={turn.id} className={cn(index > 0 && 'border-t border-divider pt-7')}>
              <TurnView turn={turn} isActive={turn.id === activeTurnId} />
            </div>
          ))}
        </div>
      </div>
      {!following && (
        <button
          type="button"
          onClick={() => {
            const container = scrollRef.current;
            if (container !== null) {
              container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            }
            setFollowing(true);
          }}
          className={cn(
            'animate-slide-up absolute bottom-4 left-1/2 flex h-8 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full',
            'border border-border-subtle bg-elevated px-3 text-[12px] text-secondary shadow-2 hover:bg-surface-3',
          )}
        >
          <ArrowDown size={13} />
          回到底部
          {unread > 0 && (
            <span className="rounded-full bg-fluent px-1.5 text-[10px] text-on-accent">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

function lastTextLen(snapshot: ThreadSnapshot | undefined): number {
  if (snapshot === undefined) return 0;
  const turn = snapshot.turns[snapshot.turns.length - 1];
  if (turn === undefined) return 0;
  const item = turn.items[turn.items.length - 1];
  if (item === undefined) return 0;
  if (item.type === 'agentMessage' || item.type === 'plan') return item.text.length;
  if (item.type === 'commandExecution') return item.outputPreview?.length ?? 0;
  return 0;
}
