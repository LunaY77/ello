/**
 * 本文件验证 goal-contract 覆盖的运行时行为契约。
 *
 * 测试通过被测入口观察协议值、错误和副作用；临时文件、进程与连接由用例生命周期显式释放。
 * 失败必须由原断言直接暴露，不使用宽松默认值或跳过分支掩盖行为漂移。
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentRunContext,
  AgentToolContext,
} from '../../src/features/agent/engine/index.js';
import {
  formatGoalStatus,
  goalUsage,
  parseGoalSlashCommand,
} from '../../src/features/thread/goals/controller.js';
import { createThreadGoalRuntime } from '../../src/features/thread/goals/runtime-tools.js';
import {
  GoalService,
  type GoalPersistencePort,
} from '../../src/features/thread/goals/service.js';
import type { GoalState } from '../../src/features/thread/goals/types.js';

function createHarness(maxContinuations = 20) {
  let snapshot: GoalState | null = null;
  let clearedId: string | null = null;
  let timestamp = Date.parse('2026-07-10T00:00:00.000Z');
  const port: GoalPersistencePort = {
    load: async () => snapshot,
    save: async (goal) => {
      snapshot = goal;
    },
    clear: async (goalId) => {
      clearedId = goalId;
      snapshot = null;
    },
  };
  const onChanged = vi.fn();
  const onCleared = vi.fn();
  const service = new GoalService({
    port,
    maxContinuations,
    now: () => new Date(timestamp),
    createId: () => 'goal-1',
    onChanged,
    onCleared,
  });
  return {
    service,
    onChanged,
    onCleared,
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
    clearedId: () => clearedId,
  };
}

const usage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 80,
  cacheWriteTokens: 30,
  toolCalls: 1,
};

describe('Goal 生命周期契约', () => {
  it('拒绝空目标、超长目标、非法预算和活动目标替换', async () => {
    const { service } = createHarness();
    await service.load();

    await expect(service.create('   ')).rejects.toThrow('must not be empty');
    await expect(service.create('x'.repeat(4001))).rejects.toThrow(
      'must not exceed 4000',
    );
    await expect(service.create('工作', 0)).rejects.toThrow('positive integer');
    await expect(service.create('工作', 1.5)).rejects.toThrow(
      'positive integer',
    );
    await service.create('  完成功能  ');
    await expect(service.create('替换目标')).rejects.toThrow('already exists');
    expect(service.current()?.objective).toBe('完成功能');
  });

  it('暂停、恢复和清除保留活动时长并产生明确审计回调', async () => {
    const { service, advance, clearedId, onCleared } = createHarness();
    await service.load();
    await service.create('完成实现');
    advance(2500);

    const paused = await service.pause();
    expect(paused).toMatchObject({
      status: 'paused',
      pauseReason: 'user',
      activeMs: 2500,
    });
    expect(paused).not.toHaveProperty('activeSince');

    const resumed = await service.resume();
    expect(resumed.status).toBe('active');
    expect(resumed).not.toHaveProperty('pauseReason');

    await service.clear();
    expect(service.current()).toBeNull();
    expect(clearedId()).toBe('goal-1');
    expect(onCleared).toHaveBeenCalledWith('goal-1');
  });

  it('同一阻塞条件必须来自三个独立运行才进入 blocked', async () => {
    const { service } = createHarness();
    await service.load();
    await service.create('发布版本');

    const first = await service.update('blocked', '缺少 API Key', 'run-1');
    const duplicate = await service.update('blocked', '缺少 API Key', 'run-1');
    const second = await service.update('blocked', '缺少 API Key', 'run-2');
    const third = await service.update('blocked', '缺少 api key', 'run-3');

    expect(first).toMatchObject({ applied: false, goal: { blockerStreak: 1 } });
    expect(duplicate).toMatchObject({
      applied: false,
      goal: { blockerStreak: 1 },
    });
    expect(second.goal.blockerStreak).toBe(2);
    expect(third).toMatchObject({
      applied: true,
      goal: { status: 'blocked', blockerStreak: 3 },
    });
  });

  it('阻塞原因变化会重置连续计数', async () => {
    const { service } = createHarness();
    await service.load();
    await service.create('发布版本');

    await service.update('blocked', '缺少 API Key', 'run-1');
    const changed = await service.update('blocked', '网络离线', 'run-2');

    expect(changed.goal).toMatchObject({
      status: 'active',
      blockerReason: '网络离线',
      blockerStreak: 1,
    });
  });

  it('计费排除缓存读取并在预算耗尽时暂停而非伪报完成', async () => {
    const { service } = createHarness();
    await service.load();
    const goal = await service.create('按预算执行', 40);

    const updated = await service.recordUsage(goal.id, usage);

    expect(updated).toMatchObject({
      tokensUsed: 40,
      status: 'paused',
      pauseReason: 'token_budget',
    });
    await expect(service.resume()).rejects.toThrow('Token budget is exhausted');
  });

  it('达到宿主延续上限时暂停且不可直接恢复', async () => {
    const { service } = createHarness(1);
    await service.load();
    const goal = await service.create('只延续一次');
    await service.beginContinuation();

    const updated = await service.recordUsage(goal.id, {
      ...usage,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
    });

    expect(updated).toMatchObject({
      status: 'paused',
      pauseReason: 'continuation_limit',
      continuationTurns: 1,
    });
    await expect(service.resume()).rejects.toThrow(
      'Continuation limit is exhausted',
    );
  });

  it('完成目标规范化原因并报告最终预算使用量', async () => {
    const { service } = createHarness();
    await service.load();
    await service.create('完成目标', 100);
    const result = await service.update('complete', '  已经   验证  ');

    expect(result).toMatchObject({
      applied: true,
      goal: {
        status: 'complete',
        completionReason: '已经 验证',
      },
      message: 'Goal marked complete. Final token usage: 0/100.',
    });
    expect(service.active()).toBeNull();
  });

  it('忽略不属于当前目标的 usage，且持久化失败不产生内存幽灵状态', async () => {
    const { service } = createHarness();
    await service.load();
    await service.create('当前目标');
    expect(await service.recordUsage('other-goal', usage)).toBeNull();
    expect(service.current()?.tokensUsed).toBe(0);

    const failingService = new GoalService({
      port: {
        load: async () => null,
        save: async () => {
          throw new Error('写盘失败');
        },
        clear: async () => undefined,
      },
      maxContinuations: 1,
      createId: () => 'failed-goal',
    });
    await failingService.load();
    await expect(failingService.create('不会生效')).rejects.toThrow('写盘失败');
    expect(failingService.current()).toBeNull();
  });
});

describe('Goal 命令契约', () => {
  it('解析管理动作和带预算的多词目标', () => {
    expect(parseGoalSlashCommand(['status'])).toEqual({ action: 'status' });
    expect(parseGoalSlashCommand(['pause'])).toEqual({ action: 'pause' });
    expect(parseGoalSlashCommand(['resume'])).toEqual({ action: 'resume' });
    expect(parseGoalSlashCommand(['clear'])).toEqual({ action: 'clear' });
    expect(
      parseGoalSlashCommand(['完成', '全部测试', '--tokens', '12000']),
    ).toEqual({
      action: 'create',
      objective: '完成 全部测试',
      tokens: 12000,
    });
  });

  it('拒绝缺失目标和位置或值非法的预算参数', () => {
    expect(() => parseGoalSlashCommand([])).toThrow(goalUsage());
    expect(() => parseGoalSlashCommand(['工作', '--tokens', '1.5'])).toThrow(
      'positive integer',
    );
    expect(() =>
      parseGoalSlashCommand(['工作', '--tokens', '10', '多余参数']),
    ).toThrow(goalUsage());
  });

  it('状态展示包含预算、延续、耗时与暂停原因', async () => {
    const { service, advance } = createHarness(3);
    await service.load();
    await service.create('展示状态', 100);
    advance(2000);
    await service.pause();

    expect(formatGoalStatus(service.status())).toContain(
      'tokens: 0/100 (100 remaining)',
    );
    expect(formatGoalStatus(service.status())).toContain(
      'continuation turns: 0',
    );
    expect(formatGoalStatus(service.status())).toContain(
      'active elapsed: 0h 0m 2s',
    );
    expect(formatGoalStatus(service.status())).toContain('pause reason: user');
  });
});

describe('Goal 生产 Turn 契约', () => {
  it('向模型暴露活动 Goal，并把终态更新返回为可持久化宿主事件', async () => {
    const goal = {
      id: 'goal-runtime',
      objective: '完成 <真实> 装配',
      status: 'active' as const,
      tokenBudget: 100,
      tokensUsed: 20,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    };
    const runtime = createThreadGoalRuntime(goal);
    const section = await runtime.systemSection({} as AgentRunContext);
    expect(section).toContain('完成 &lt;真实&gt; 装配');
    expect(section).not.toContain('<objective>完成 <真实>');
    expect(section).toContain('20/100');

    const getGoal = immediateTool(runtime.tools, 'get_goal');
    expect(getGoal.execute({}, TOOL_CONTEXT)).toMatchObject({
      id: goal.id,
      remainingTokens: 80,
    });
    const updateGoal = immediateTool(runtime.tools, 'update_goal');
    expect(
      updateGoal.execute({ status: 'complete' }, TOOL_CONTEXT),
    ).toMatchObject({
      kind: 'thread-goal-updated',
      goal: { id: goal.id, status: 'complete' },
    });
    expect(() =>
      updateGoal.execute({ status: 'blocked' }, TOOL_CONTEXT),
    ).toThrow('current status is complete');
    expect(runtime.systemSection({} as AgentRunContext)).toBeNull();
  });

  it('没有 Goal 时查询和更新都明确失败', async () => {
    const runtime = createThreadGoalRuntime(null);
    expect(() =>
      immediateTool(runtime.tools, 'get_goal').execute({}, TOOL_CONTEXT),
    ).toThrow('No goal exists');
    expect(() =>
      immediateTool(runtime.tools, 'update_goal').execute(
        { status: 'complete' },
        TOOL_CONTEXT,
      ),
    ).toThrow('No goal exists');
  });
});

const TOOL_CONTEXT: AgentToolContext = {
  runId: 'run-goal',
  turnIndex: 0,
  toolCallId: 'call-goal',
  environment: {},
  metadata: {},
  signal: new AbortController().signal,
};

function immediateTool(
  tools: ReturnType<typeof createThreadGoalRuntime>['tools'],
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined || tool.execution !== 'immediate') {
    throw new Error(`Missing immediate tool ${name}.`);
  }
  return tool;
}
