import type { Meta, StoryObj } from '@storybook/react';

import { CodeBlock, Markdown } from './Markdown';

import { SAMPLE_MARKDOWN } from '@/testing/fixtures-app';
import { Padded } from '@/testing/Storybook';


const meta = {
  title: 'UI/Markdown',
  component: Markdown,
  args: { text: SAMPLE_MARKDOWN },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/** GFM 全量:标题/列表/表格/引用/行内代码/链接 + 三段式代码卡。 */
export const Rich: Story = {
  args: { text: SAMPLE_MARKDOWN },
  render: (args) => (
    <Padded width={640}>
      <Markdown text={args.text} />
    </Padded>
  ),
};

/** 流式输出:末尾脉动光标。 */
export const Streaming: Story = {
  render: () => (
    <Padded width={640}>
      <Markdown text={'收到,我把锁定阈值从 5 调整到 3,同时把冷却时间抽成配置项…'} streaming />
    </Padded>
  ),
};

export const CodeLanguages: Story = {
  render: () => (
    <Padded width={640}>
      <div className="flex flex-col gap-4">
        <CodeBlock
          language="ts"
          code={`// 校验验证码(常数时间比较)\nexport async function verifyCode(userId: string, code: string): Promise<boolean> {\n  const record = await codes.findLatest(userId);\n  if (record === null || record.expiresAt < Date.now()) return false;\n  return timingSafeEqual(record.code, code);\n}`}
        />
        <CodeBlock
          language="bash"
          code={`# 重新安装依赖\n$ pnpm install --frozen-lockfile && pnpm --filter @ello/app build`}
        />
        <CodeBlock
          language="json"
          code={`{"scripts": {"dev": "vite", "build": "vite build"}, "private": true}`}
        />
        <CodeBlock
          code={`纯文本,未识别语言不高亮`}
        />
      </div>
    </Padded>
  ),
};

/** 长代码:横向滚动,不撑破容器。 */
export const LongCode: Story = {
  render: () => (
    <Padded width={640}>
      <CodeBlock
        language="ts"
        code={`const veryLong = '这是一行非常非常非常长的代码,用来验证代码块在窄容器中的横向滚动行为是否正常,不应该撑破布局也不应该出现文字溢出卡片的情况';\n${'export const x = 1;\n'.repeat(30)}`}
      />
    </Padded>
  ),
};
