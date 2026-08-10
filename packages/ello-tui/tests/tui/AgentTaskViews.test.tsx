import { renderToString } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import type {
  AgentTaskDetail,
  AgentTaskSummary,
} from '../../src/api/protocol-types.js';
import { AgentSwitcher } from '../../src/tui/component/AgentSwitcher.js';
import { AgentTranscript } from '../../src/tui/component/AgentTranscript.js';
import { resolveTheme, ThemeProvider } from '../../src/tui/theme/index.js';

const createdAt = '2026-07-29T00:00:00.000Z';

describe('Agent task views', () => {
  it('Agent switcher 按终端宽度依次隐藏说明、token、耗时', () => {
    const task = agentTask();

    const full = renderSwitcher(task, 120);
    expect(full).toContain('检查很长的中文任务说明');
    expect(full).toContain('tokens');

    const narrow = renderSwitcher(task, 60);
    expect(narrow).not.toContain('检查很长的中文任务说明');
    expect(narrow).not.toContain('tokens');
    expect(narrow).toContain('running · 0s');

    const compact = renderSwitcher(task, 39);
    expect(compact).not.toContain('检查很长的中文任务说明');
    expect(compact).not.toContain('0s');
    expect(compact).toContain('running');
  });

  it('child transcript 展示运行边界，并由展开态控制完整工具结果', () => {
    const task = agentTask({
      parentTaskId: 'job_parent',
      executionMode: 'foreground',
    });
    const detail: AgentTaskDetail = {
      task,
      prompt: '检查工具轨迹',
      events: [
        {
          rootThreadId: task.rootThreadId,
          taskId: task.taskId,
          sequence: 1,
          rootSequence: 1,
          eventType: 'commandRunEvent',
          payload: {
            type: 'commandRunEvent',
            event: {
              type: 'command.started',
              record: {
                commandId: 'tool_read',
                name: 'read',
                input: { path: '/workspace/src/main.ts' },
              },
            },
          },
          createdAt,
        },
        {
          rootThreadId: task.rootThreadId,
          taskId: task.taskId,
          sequence: 2,
          rootSequence: 2,
          eventType: 'commandRunEvent',
          payload: {
            type: 'commandRunEvent',
            event: {
              type: 'command.completed',
              record: {
                commandId: 'tool_read',
                name: 'read',
                output: { output: 'READ_FULL_MARKER' },
              },
            },
          },
          createdAt,
        },
      ],
    };

    const transcript = renderTranscript(task, detail, 40);
    expect(transcript).toContain('shared');
    expect(transcript).toContain('parent:job_parent');
    expect(transcript).toContain('Ctrl+B to background');
    expect(transcript).toContain('READ_FULL_MARKER');
  });
});

function renderSwitcher(task: AgentTaskSummary, columns: number): string {
  return renderAtColumns(
    <ThemeProvider theme={resolveTheme('tokyo-night')}>
      <AgentSwitcher
        tasks={[task]}
        activeView={{ kind: 'main', threadId: task.rootThreadId }}
        focus="composer"
        highlightedTaskId="main"
      />
    </ThemeProvider>,
    columns,
  );
}

function renderTranscript(
  task: AgentTaskSummary,
  detail: AgentTaskDetail,
  columns: number,
): string {
  return renderAtColumns(
    <ThemeProvider theme={resolveTheme('tokyo-night')}>
      <AgentTranscript task={task} detail={detail} />
    </ThemeProvider>,
    columns,
  );
}

function renderAtColumns(element: ReactElement, columns: number): string {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: columns,
  });
  try {
    return renderToString(element, { columns });
  } finally {
    if (descriptor === undefined)
      Reflect.deleteProperty(process.stdout, 'columns');
    else Object.defineProperty(process.stdout, 'columns', descriptor);
  }
}

function agentTask(
  overrides: Partial<AgentTaskSummary> = {},
): AgentTaskSummary {
  return {
    taskId: 'job_child',
    agentId: 'agent_child',
    rootThreadId: 'thr_root',
    name: 'reader-with-a-long-name',
    definitionName: 'explore',
    description: '检查很长的中文任务说明',
    contextMode: 'fork',
    executionMode: 'background',
    status: 'running',
    cwd: '/workspace',
    isolation: 'shared',
    revision: 2,
    eventSequence: 2,
    usage: {
      requests: 1,
      inputTokens: 1_200,
      outputTokens: 12_345,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 1,
    },
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
    ...overrides,
    toolCount: overrides.toolCount ?? 1,
    recentTools: overrides.recentTools ?? [],
  };
}
