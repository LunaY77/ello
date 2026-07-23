/**
 * 应用级 fixture:故事与测试共用的协议形状样本。
 * 时间固定在 2026-07-22,不读取当前时间;字段完整、可直接过 schema。
 */
import type {
  FileChange,
  ThreadItem,
  ThreadSnapshot,
  Turn,
} from '@ello/agent/protocol';

import { EMPTY_USAGE, makeSnapshot, makeSummary, makeTurn, makeUserItem, makeAgentItem } from './fixtures';

import type {
  PendingRequestEntry,
  Repository,
  Task,
  Workspace,
} from '@/store/types';
import type { CatalogEntry } from '@/store/types';


export const FIXED_NOW = '2026-07-22T08:00:00Z';

export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-search-page',
    kind: 'feature',
    name: 'search-page',
    rootPath: '/data/workspace/search-page',
    status: 'active',
    branch: 'feature/search-page',
    repositories: [{}, {}, {}],
    createdAt: '2026-07-18T02:00:00Z',
    updatedAt: '2026-07-22T06:30:00Z',
    ...overrides,
  };
}

export const SAMPLE_DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
index 3f8a2c1..9b14e77 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -12,7 +12,10 @@ export async function login(credentials: Credentials) {
   const session = await createSession(credentials);
-  if (!session.verified) {
-    throw new AuthError('unverified');
-  }
+  if (!session.verified) {
+    await sendVerificationCode(session.userId);
+    throw new AuthError('verification_required', {
+      resendAfterSeconds: 60,
+    });
+  }
   return session;
 }`;

export const SAMPLE_MARKDOWN = `## 实施方案

验证码校验拆成三步:

1. **发送**:\`POST /auth/code\` 生成 6 位验证码,60 秒冷却
2. **校验**:登录接口先过验证码,再过密码
3. **限流**:同一账号 5 次失败后锁定 10 分钟

| 接口 | 变更 | 风险 |
| ---- | ---- | ---- |
| /auth/login | 增加 code 字段 | 低 |
| /auth/code | 新增 | 中 |

> 注意:旧客户端没有验证码输入框,需要灰度开关。

\`\`\`ts
export async function verifyCode(userId: string, code: string): Promise<boolean> {
  const record = await codes.findLatest(userId);
  if (record === null || record.expiresAt < Date.now()) return false;
  return timingSafeEqual(record.code, code);
}
\`\`\`

详细设计见 [认证流程文档](https://example.com/docs/auth)。`;

export function makeReasoningItem(turnId: string, status: 'inProgress' | 'completed' = 'completed'): ThreadItem {
  return {
    id: `item-reasoning-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'reasoning',
    summary:
      '登录流程在 src/auth/login.ts,会话创建在 session.ts。验证码适合挂在 createSession 之前,复用现有的限流中间件。',
    status,
  };
}

export function makePlanItem(turnId: string, status: 'inProgress' | 'completed' = 'completed'): ThreadItem {
  return {
    id: `item-plan-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'plan',
    text: SAMPLE_MARKDOWN,
    contentHash: 'sha256:9f2c',
    status,
  };
}

export function makeCommandItem(
  turnId: string,
  overrides: Partial<Extract<ThreadItem, { readonly type: 'commandExecution' }>> = {},
): Extract<ThreadItem, { readonly type: 'commandExecution' }> {
  return {
    id: `item-cmd-${turnId}-${overrides.command ?? 'default'}`.replace(/\W+/g, '-'),
    turnId,
    createdAt: FIXED_NOW,
    type: 'commandExecution',
    command: 'pnpm test',
    cwd: '/data/workspace/search-page',
    status: 'completed',
    outputPreview: '✓ auth/login.test.ts (12 tests) 154ms\n✓ auth/code.test.ts (8 tests) 96ms\n\nTest Files  2 passed (2)\n     Tests  20 passed (20)',
    outputBytes: 4096,
    exitCode: 0,
    durationMs: 4600,
    ...overrides,
  };
}

export function makeFileChangeItem(
  turnId: string,
  changes: readonly FileChange[] = [
    {
      path: 'src/auth/login.ts',
      kind: 'modify',
      additions: 7,
      deletions: 3,
      diff: SAMPLE_DIFF,
    },
  ],
): Extract<ThreadItem, { readonly type: 'fileChange' }> {
  return {
    id: `item-fc-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'fileChange',
    changes,
    status: 'completed',
  };
}

export function makeToolCallItem(
  turnId: string,
  overrides: Partial<Extract<ThreadItem, { readonly type: 'toolCall' }>> = {},
): Extract<ThreadItem, { readonly type: 'toolCall' }> {
  return {
    id: `item-tool-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'toolCall',
    toolName: 'grep',
    headline: '在 src/auth 下搜索 createSession',
    status: 'completed',
    outputPreview: 'src/auth/session.ts:41:export async function createSession(...)',
    ...overrides,
  };
}

export function makeSubagentItem(
  turnId: string,
  background = false,
): Extract<ThreadItem, { readonly type: 'subagent' }> {
  return {
    id: `item-sub-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'subagent',
    agentName: 'code-reviewer',
    description: '审查验证码改动的边界条件',
    background,
    status: background ? 'inProgress' : 'completed',
    output: background ? undefined : '发现 2 处建议:验证码比较需要常数时间实现;冷却时间应可配置。',
  };
}

export function makeNoticeItem(turnId: string, level: 'info' | 'warning' = 'info'): ThreadItem {
  return {
    id: `item-notice-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'notice',
    level,
    message: level === 'warning' ? '上下文使用已超过 80%,建议尽快收尾当前回合' : '已切换到 plan 模式',
  };
}

export function makeErrorItem(turnId: string): ThreadItem {
  return {
    id: `item-err-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'error',
    code: 'toolExecutionFailed',
    message: '命令执行超时(30s):pnpm e2e',
  };
}

export function makeCompactionItem(turnId: string): ThreadItem {
  return {
    id: `item-compact-${turnId}`,
    turnId,
    createdAt: FIXED_NOW,
    type: 'contextCompaction',
    summary: '前 12 条消息已压缩:用户要求加验证码,已完成发送与校验,剩限流。',
    tokensBefore: 48200,
    status: 'completed',
  };
}

/** 完整会话快照:一个已完成回合 + 一个进行中的回合,覆盖全部 item 形态。 */
export function makeRichSnapshot(): ThreadSnapshot {
  const summary = makeSummary({
    id: 'thread-rich',
    cwd: '/data/workspace/search-page',
    name: '给登录加验证码校验',
    status: 'running',
  });
  const turn1: Turn = {
    ...makeTurn({ threadId: summary.id, status: 'completed' }),
    id: 'turn-rich-1',
    completedAt: FIXED_NOW,
    items: [
      makeUserItem('turn-rich-1', '给这个仓库的用户登录加上验证码校验'),
      makeAgentItem('turn-rich-1', '我先看一下现有的登录流程和会话创建逻辑。'),
      makeToolCallItem('turn-rich-1'),
      makeCommandItem('turn-rich-1'),
      makeFileChangeItem('turn-rich-1'),
      makeAgentItem('turn-rich-1', SAMPLE_MARKDOWN),
      makeNoticeItem('turn-rich-1'),
    ],
  };
  const turn2: Turn = {
    ...makeTurn({ threadId: summary.id }),
    id: 'turn-rich-2',
    items: [
      makeUserItem('turn-rich-2', '限流规则改成 3 次失败就锁定'),
      makeReasoningItem('turn-rich-2'),
      makeAgentItem('turn-rich-2', '收到,我把锁定阈值从 5 调整到 3,同时把冷却时间抽成配置项。', 'inProgress'),
      makeCommandItem('turn-rich-2', {
        command: 'pnpm test:watch auth',
        status: 'inProgress',
        exitCode: undefined,
        durationMs: undefined,
        outputPreview: 'watching for file changes…\n',
      }),
      makeSubagentItem('turn-rich-2', true),
      makeErrorItem('turn-rich-2'),
      makeCompactionItem('turn-rich-2'),
    ],
  };
  return makeSnapshot({
    thread: summary,
    seq: 42,
    turns: [turn1, turn2],
    usage: { ...EMPTY_USAGE, requests: 9, inputTokens: 48200, outputTokens: 12600, toolCalls: 14 },
  });
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    boardId: 'board-main',
    subject: '验证码接口限流',
    description: '同一账号 3 次失败后锁定 10 分钟,冷却时间进配置。',
    status: 'inProgress',
    owner: 'ello',
    blockedBy: [],
    metadata: {},
    createdAt: '2026-07-22T03:00:00Z',
    updatedAt: '2026-07-22T06:00:00Z',
    ...overrides,
  };
}

export const MODEL_ENTRIES: readonly CatalogEntry[] = [
  { id: 'claude-opus-4-8', name: 'claude-opus-4-8', title: 'Claude Opus 4.8', enabled: true, metadata: {} },
  { id: 'claude-sonnet-5', name: 'claude-sonnet-5', title: 'Claude Sonnet 5', enabled: true, metadata: {} },
  { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5', title: 'Claude Haiku 4.5', enabled: true, metadata: {} },
];

export const REPOSITORIES: readonly Repository[] = [
  {
    id: 'repo-ello',
    key: 'ello',
    sourceUrl: 'https://example.com/ello.git',
    mirrorPath: '/data/repos/ello.git',
    defaultBranch: 'main',
    createdAt: '2026-07-10T08:00:00Z',
    updatedAt: FIXED_NOW,
  },
  {
    id: 'repo-auth-service',
    key: 'auth-service',
    sourceUrl: 'https://example.com/auth-service.git',
    mirrorPath: '/data/repos/auth-service.git',
    defaultBranch: 'main',
    createdAt: '2026-07-11T08:00:00Z',
    updatedAt: FIXED_NOW,
  },
];

export const SKILL_ENTRIES: readonly CatalogEntry[] = [
  {
    id: 'skills/code-review@a1b2c3',
    name: 'code-review',
    title: '代码评审',
    description: '按团队 checklist 评审改动:边界条件、错误处理、测试覆盖。',
    enabled: true,
    metadata: {},
  },
  {
    id: 'skills/commit-message@d4e5f6',
    name: 'commit-message',
    title: '提交信息生成',
    description: '根据 diff 生成符合 Conventional Commits 的提交信息。',
    enabled: true,
    metadata: {},
  },
  {
    id: 'skills/api-modernization@7g8h9i',
    name: 'api-modernization',
    title: 'API 现代化',
    description: '识别需要升级的 API 调用点并给出直接修改方案。',
    enabled: false,
    metadata: {},
  },
];

export function makeApprovalEntry(
  overrides: Partial<PendingRequestEntry> & Pick<PendingRequestEntry, 'id' | 'method' | 'params'>,
): PendingRequestEntry {
  return {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-1',
    createdAt: FIXED_NOW,
    state: 'pending',
    ...overrides,
  };
}

export const APPROVAL_COMMAND: PendingRequestEntry = makeApprovalEntry({
  id: 'srvreq_cmd1',
  method: 'item/commandExecution/requestApproval',
  params: {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-1',
    reason: '运行测试以验证新加的验证码校验用例',
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    command: ['pnpm', 'test'],
    cwd: '/data/workspace/search-page',
  },
});

export const APPROVAL_COMMAND_DANGEROUS: PendingRequestEntry = makeApprovalEntry({
  id: 'srvreq_cmd2',
  method: 'item/commandExecution/requestApproval',
  params: {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-2',
    reason: '清理构建产物后重新安装依赖',
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    command: ['sudo', 'rm', '-rf', 'node_modules'],
    cwd: '/data/workspace/search-page',
  },
});

export const APPROVAL_FILE_CHANGE: PendingRequestEntry = makeApprovalEntry({
  id: 'srvreq_fc1',
  method: 'item/fileChange/requestApproval',
  params: {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-3',
    reason: '新增验证码发送与校验逻辑',
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    paths: ['src/auth/login.ts', 'src/auth/code.ts', 'tests/auth/code.test.ts'],
    summary: '新增验证码模块并接入登录流程,共 3 个文件',
  },
});

export const APPROVAL_PERMISSION: PendingRequestEntry = makeApprovalEntry({
  id: 'srvreq_pm1',
  method: 'item/permissions/requestApproval',
  params: {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-4',
    reason: '需要读取项目配置以确认短信服务商密钥位置',
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    permission: 'config.read',
    scope: 'project',
  },
});

export const APPROVAL_PLAN: PendingRequestEntry = makeApprovalEntry({
  id: 'srvreq_pl1',
  method: 'item/plan/requestApproval',
  params: {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-5',
    reason: '计划已就绪,等待批准后进入执行',
    availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    contentHash: 'sha256:9f2c',
    preview: '1. 新增 POST /auth/code\n2. 登录接口接入验证码\n3. 限流:3 次失败锁定 10 分钟\n4. 灰度开关 auth.code.required',
  },
});

export const APPROVAL_USER_INPUT: PendingRequestEntry = makeApprovalEntry({
  id: 'srvreq_ui1',
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-rich',
    turnId: 'turn-rich-2',
    itemId: 'item-6',
    reason: '',
    questions: [
      {
        id: 'q-channel',
        header: '发送通道',
        question: '验证码通过什么通道下发?',
        multiple: false,
        options: [
          { label: '短信', description: '复用现有短信服务商,到达率高' },
          { label: '邮件', description: '零成本,但到达率与实时性较差' },
        ],
      },
      {
        id: 'q-scope',
        header: '灰度范围',
        question: '首批放量到哪些环境?(可多选)',
        multiple: true,
        options: [
          { label: 'dev', description: '开发环境,随时可开' },
          { label: 'staging', description: '预发环境,需要通知 QA' },
          { label: 'prod-canary', description: '生产 5% 灰度,需要审批' },
        ],
      },
    ],
  },
});
