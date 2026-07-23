import type { Meta, StoryObj } from '@storybook/react';

import { TurnView } from './TurnView';

import {
  makeAgentItem,
  makeUserItem,
} from '@/testing/fixtures';
import { makeTurn } from '@/testing/fixtures';
import {
  makeCommandItem,
  makeCompactionItem,
  makeErrorItem,
  makeFileChangeItem,
  makeNoticeItem,
  makePlanItem,
  makeReasoningItem,
  makeRichSnapshot,
  makeSubagentItem,
  makeToolCallItem,
} from '@/testing/fixtures-app';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'Timeline/TurnView',
  component: TurnView,
  args: { turn: makeTurn({ threadId: 'thread-story' }), isActive: false },
} satisfies Meta<typeof TurnView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 完整回合:用户气泡、助手消息(含 markdown)、推理、计划、系统行、错误行。 */
export const CompletedTurn: Story = {
  render: () => {
    const turn = {
      ...makeTurn({ threadId: 'thread-story', status: 'completed' }),
      id: 'turn-story-1',
      items: [
        makeUserItem('turn-story-1', '给这个仓库的用户登录加上验证码校验'),
        makeReasoningItem('turn-story-1'),
        makeAgentItem('turn-story-1', '我先看一下现有的登录流程和会话创建逻辑。'),
        makePlanItem('turn-story-1'),
        makeAgentItem('turn-story-1', '已按计划完成发送与校验两步,接下来处理限流。'),
        makeNoticeItem('turn-story-1'),
        makeCompactionItem('turn-story-1'),
        makeErrorItem('turn-story-1'),
      ],
    };
    return (
      <Padded width={720}>
        <TurnView turn={turn} isActive={false} />
      </Padded>
    );
  },
};

/** 进行中:徽标脉动 + 流式光标。 */
export const ActiveStreaming: Story = {
  render: () => {
    const turn = {
      ...makeTurn({ threadId: 'thread-story' }),
      id: 'turn-story-2',
      items: [
        makeUserItem('turn-story-2', '限流规则改成 3 次失败就锁定'),
        makeReasoningItem('turn-story-2', 'inProgress'),
        makeAgentItem('turn-story-2', '收到,我把锁定阈值从 5 调整到 3,同时…', 'inProgress'),
      ],
    };
    return (
      <Padded width={720}>
        <TurnView turn={turn} isActive />
      </Padded>
    );
  },
};

/** 工具组:命令 + 文件变更 + 子代理折叠为一颗胶囊。 */
export const ToolRun: Story = {
  render: () => {
    const turn = {
      ...makeTurn({ threadId: 'thread-story', status: 'completed' }),
      id: 'turn-story-3',
      items: [
        makeToolCallItem('turn-story-3'),
        makeCommandItem('turn-story-3'),
        makeFileChangeItem('turn-story-3'),
        makeSubagentItem('turn-story-3'),
      ],
    };
    return (
      <Padded width={720}>
        <TurnView turn={turn} isActive={false} />
      </Padded>
    );
  },
};

/** 长用户消息:气泡限宽 70% 并换行。 */
export const LongUserMessage: Story = {
  render: () => {
    const turn = {
      ...makeTurn({ threadId: 'thread-story', status: 'completed' }),
      id: 'turn-story-4',
      items: [
        makeUserItem(
          'turn-story-4',
          '把登录接口的验证码逻辑整理一下:发送通道先只保留短信,邮件后面再说;冷却时间 60 秒做成配置项,别写死;失败 3 次锁定 10 分钟,锁定期内即使是正确验证码也要拒绝,并返回剩余秒数。另外补一下这几个边界的测试用例。',
        ),
      ],
    };
    return (
      <Padded width={720}>
        <TurnView turn={turn} isActive={false} />
      </Padded>
    );
  },
};

export const RichThread: Story = {
  render: () => {
    const snapshot = makeRichSnapshot();
    const turn = snapshot.turns[1];
    if (turn === undefined) throw new Error('fixture missing turn');
    return (
      <Padded width={720}>
        <TurnView turn={turn} isActive />
      </Padded>
    );
  },
};
