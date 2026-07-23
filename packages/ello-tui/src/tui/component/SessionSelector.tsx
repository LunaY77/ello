import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';

import type { ThreadSummary } from '../../api/protocol-types.js';
import { useTheme } from '../theme/index.js';

import {
  cycleSessionSelectorFocus,
  selectSessions,
  type SessionCwdFilter,
  type SessionSelectorFocus,
  type SessionSortOrder,
} from './session-selector-model.js';

export type SessionSelectorAction = 'resume' | 'unarchive';

export interface SessionSelectorProps {
  readonly action: SessionSelectorAction;
  readonly sessions: readonly ThreadSummary[];
  readonly currentCwd: string;
  onSelect(threadId: string, action: SessionSelectorAction): void;
}

const VISIBLE_ROWS = 8;

/** Codex 风格 Thread 选择器：搜索、cwd 范围、排序与选中项详情共享一个键盘焦点模型。 */
export function SessionSelector({
  action,
  sessions,
  currentCwd,
  onSelect,
}: SessionSelectorProps) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [cwdFilter, setCwdFilter] = useState<SessionCwdFilter>('all');
  const [sortOrder, setSortOrder] = useState<SessionSortOrder>('updated');
  const [focus, setFocus] = useState<SessionSelectorFocus>('search');
  const [index, setIndex] = useState(0);
  const [expandedSessionId, setExpandedSessionId] = useState<string>();
  const visible = useMemo(
    () => selectSessions(sessions, query, cwdFilter, currentCwd, sortOrder),
    [sessions, query, cwdFilter, currentCwd, sortOrder],
  );

  const boundedIndex = Math.min(index, Math.max(0, visible.length - 1));

  useInput((input, key) => {
    if (key.tab) {
      setFocus((current) =>
        cycleSessionSelectorFocus(current, key.shift === true),
      );
      return;
    }
    if (key.upArrow) {
      setFocus('list');
      setIndex(Math.max(0, boundedIndex - 1));
      setExpandedSessionId(undefined);
      return;
    }
    if (key.downArrow) {
      setFocus('list');
      setIndex(Math.min(Math.max(0, visible.length - 1), boundedIndex + 1));
      setExpandedSessionId(undefined);
      return;
    }
    if ((key.leftArrow || key.rightArrow) && focus === 'cwd') {
      setCwdFilter((current) => (current === 'all' ? 'current' : 'all'));
      setIndex(0);
      setExpandedSessionId(undefined);
      return;
    }
    if ((key.leftArrow || key.rightArrow) && focus === 'sort') {
      setSortOrder((current) =>
        current === 'updated' ? 'created' : 'updated',
      );
      setIndex(0);
      setExpandedSessionId(undefined);
      return;
    }
    if (key.ctrl && input === 'e') {
      const selected = visible[boundedIndex];
      if (selected !== undefined) {
        setExpandedSessionId((current) =>
          current === selected.id ? undefined : selected.id,
        );
      }
      return;
    }
    if (key.return) {
      const selected = visible[boundedIndex];
      if (selected !== undefined) onSelect(selected.id, action);
      return;
    }
    if (key.backspace || key.delete) {
      setFocus('search');
      setQuery((current) => current.slice(0, -1));
      setIndex(0);
      setExpandedSessionId(undefined);
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      setFocus('search');
      setQuery((current) => current + input);
      setIndex(0);
      setExpandedSessionId(undefined);
    }
  });

  const windowStart = windowStartFor(
    boundedIndex,
    visible.length,
    VISIBLE_ROWS,
  );
  const windowSessions = visible.slice(windowStart, windowStart + VISIBLE_ROWS);
  const title =
    action === 'resume' ? 'Resume a previous session' : 'Unarchive a session';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.info}
      paddingX={1}
    >
      <Text color={theme.info}>{title}</Text>
      <Box justifyContent="space-between">
        <Text color={focus === 'search' ? theme.accent : theme.textMuted}>
          {query === '' ? 'Type to search' : `Search: ${query}`}
          {focus === 'search' ? '_' : ''}
        </Text>
        <Text color={theme.textMuted}>
          {'Filter: '}
          <Text color={focus === 'cwd' ? theme.accent : theme.text}>
            {`Cwd [${cwdFilter === 'all' ? 'All' : 'Current'}]`}
          </Text>
          {'   Sort: '}
          <Text color={focus === 'sort' ? theme.accent : theme.text}>
            {sortOrder === 'updated'
              ? '[Updated] Created'
              : 'Updated [Created]'}
          </Text>
        </Text>
      </Box>
      <Text color={theme.textMuted}>{'─'.repeat(72)}</Text>
      {windowSessions.length === 0 ? (
        <Text color={theme.textMuted}>No matching sessions</Text>
      ) : (
        windowSessions.map((session, offset) => {
          const sessionIndex = windowStart + offset;
          return (
            <SessionRow
              key={session.id}
              session={session}
              selected={sessionIndex === boundedIndex}
              focused={focus === 'list'}
              expanded={
                sessionIndex === boundedIndex &&
                expandedSessionId === session.id
              }
            />
          );
        })
      )}
      <Text color={theme.textMuted}>
        {`${visible.length === 0 ? 0 : boundedIndex + 1} / ${visible.length} · Tab focus · ←/→ option · ↑/↓ browse · Ctrl+E expand/collapse · Enter ${action}`}
      </Text>
    </Box>
  );
}

function SessionRow({
  session,
  selected,
  focused,
  expanded,
}: {
  readonly session: ThreadSummary;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly expanded: boolean;
}) {
  const theme = useTheme();
  const marker = selected ? (expanded ? '⌄' : '›') : ' ';
  const title = sessionTitle(session);
  const color = selected && focused ? theme.accent : theme.text;
  return (
    <Box flexDirection="column">
      <Text
        color={color}
      >{`${marker} ${relativeTime(session.updatedAt).padEnd(11)} ${title}`}</Text>
      {expanded ? (
        <>
          <Text color={theme.textMuted}>{`  │ Session:    ${session.id}`}</Text>
          <Text
            color={theme.textMuted}
          >{`  │ Created:    ${absoluteTime(session.createdAt)}`}</Text>
          <Text
            color={theme.textMuted}
          >{`  │ Updated:    ${absoluteTime(session.updatedAt)}`}</Text>
          <Text
            color={theme.textMuted}
          >{`  │ Directory:  ${session.cwd}`}</Text>
          <Text color={theme.textMuted}>{'  │ Conversation:'}</Text>
          <Text color={theme.text}>{`  │ ${conversation(session)}`}</Text>
        </>
      ) : null}
    </Box>
  );
}

function sessionTitle(session: ThreadSummary): string {
  if (session.name.trim() !== '') return session.name;
  if (session.preview.trim() !== '') return session.preview;
  return 'Untitled session';
}

function conversation(session: ThreadSummary): string {
  if (session.name.trim() !== '' && session.preview.trim() !== '') {
    return `${session.name} · ${session.preview}`;
  }
  return sessionTitle(session);
}

function absoluteTime(value: string): string {
  const date = new Date(timestamp(value));
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function relativeTime(value: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp(value)) / 1000),
  );
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid Thread timestamp ${value}.`);
  }
  return parsed;
}

function windowStartFor(index: number, total: number, size: number): number {
  if (total <= size) return 0;
  return Math.min(Math.max(0, index - Math.floor(size / 2)), total - size);
}
