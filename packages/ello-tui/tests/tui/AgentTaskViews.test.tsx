import { renderToString } from 'ink';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import type {
  AgentTaskDetail,
  AgentTaskSummary,
} from '../../src/api/protocol-types.js';
import { AgentSwitcher } from '../../src/tui/component/AgentSwitcher.js';
import {
  AgentTranscript,
  AgentTranscriptHistoryOutput,
} from '../../src/tui/component/AgentTranscript.js';
import { SubagentActivity } from '../../src/tui/component/SubagentActivity.js';
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

    const completed = renderSwitcher(
      agentTask({ status: 'completed', completedAt: createdAt }),
      120,
    );
    expect(completed).toContain('completed · 0s · 13.5k tokens');
  });

  it('Agent transcript 展示 Task Packet 边界，并由展开态控制完整工具结果', () => {
    const task = agentTask();
    const detail: AgentTaskDetail = {
      task,
      taskPacket: {
        objective: '检查工具轨迹',
        scope: '/workspace/src',
        knownFacts: [],
        constraints: ['只读'],
        expectedOutcome: '返回工具轨迹报告',
        acceptanceEvidence: ['包含实际读取结果'],
      },
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
    expect(transcript).toContain('检查工具轨迹');
    expect(transcript).toContain('READ_FULL_MARKER');
  });

  it('Agent transcript 隐藏内部结果 envelope，并展示结构化结果', () => {
    const task = agentTask({
      status: 'completed',
      revision: 3,
      eventSequence: 1,
      completedAt: createdAt,
    });
    const detail: AgentTaskDetail = {
      task,
      taskPacket: {
        objective: '检查结果展示',
        scope: '/workspace',
        knownFacts: [],
        constraints: [],
        expectedOutcome: '返回结构化结果',
        acceptanceEvidence: ['结果可读'],
      },
      result: {
        status: 'completed',
        summary: '检查完成',
        evidence: ['tests passed'],
        remainingRisks: [],
      },
      events: [
        {
          rootThreadId: task.rootThreadId,
          taskId: task.taskId,
          sequence: 1,
          rootSequence: 1,
          eventType: 'messageCompleted',
          payload: {
            messageId: 'message_result',
            text: '<agent-result>{"status":"completed"}</agent-result>',
          },
          createdAt,
        },
      ],
    };

    const transcript = renderTranscript(task, detail, 80);
    expect(transcript).toContain('Done: 检查完成');
    expect(transcript).toContain('Evidence: tests passed');
    expect(transcript).not.toContain('<agent-result>');
    expect(transcript).not.toContain('"status":"completed"');
  });

  it('Agent transcript 的当前状态留在动态区，不写入 Static header', () => {
    const runningTask = agentTask();
    const completedTask = agentTask({
      status: 'completed',
      completedAt: createdAt,
    });
    const detail: AgentTaskDetail = {
      task: runningTask,
      taskPacket: {
        objective: '检查状态刷新',
        scope: '/workspace',
        knownFacts: [],
        constraints: [],
        expectedOutcome: '状态可刷新',
        acceptanceEvidence: [],
      },
      events: [],
    };

    const header = renderAtColumns(
      <ThemeProvider theme={resolveTheme('tokyo-night')}>
        <AgentTranscriptHistoryOutput
          task={runningTask}
          detail={detail}
          resetKey={1}
        />
      </ThemeProvider>,
      80,
    );
    const liveStatus = renderAtColumns(
      <ThemeProvider theme={resolveTheme('tokyo-night')}>
        <AgentTranscript
          task={completedTask}
          detail={{ ...detail, task: completedTask }}
          maxRows={1}
          textWidth={80}
        />
      </ThemeProvider>,
      80,
    );

    expect(header).not.toContain('running');
    expect(liveStatus).toBe('completed');
  });

  it('blocked/stopped 摘要优先展示结构化 result preview', () => {
    const output = renderAtColumns(
      <ThemeProvider theme={resolveTheme('tokyo-night')}>
        <SubagentActivity
          cwd="/workspace"
          run={{
            runId: 'job_blocked',
            agentName: 'explore',
            description: '等待产品决策',
            status: 'blocked',
            startedAt: createdAt,
            completedAt: createdAt,
            tools: [],
            output: '需要确认公开 API 命名',
          }}
        />
      </ThemeProvider>,
      80,
    );

    expect(output).toContain('Blocked');
    expect(output).toContain('需要确认公开 API 命名');
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
      <AgentTranscriptHistoryOutput task={task} detail={detail} resetKey={1} />
      <AgentTranscript
        task={task}
        detail={detail}
        maxRows={8}
        textWidth={columns}
      />
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
