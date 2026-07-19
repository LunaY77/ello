import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UserInputPanel } from '../../src/tui/component/UserInputPanel.js';
import type { UserInputRequest } from '../../src/tui/store/history-entry.js';

const pending: UserInputRequest = {
  id: 'ask-1',
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'tool-1',
    reason: 'Need a storage choice',
    questions: [
      {
        id: 'storage',
        header: 'Storage',
        question: 'Which storage?',
        options: [
          { label: 'SQLite', description: 'Recommended locally.' },
          { label: 'JSONL', description: 'Append-only.' },
        ],
        multiple: false,
      },
    ],
  },
  respond: async () => undefined,
  reject: async () => undefined,
};

describe('用户输入面板', () => {
  it('显示推荐项，并在复核后提交单选答案', async () => {
    const onResolve = vi.fn(async () => undefined);
    const view = render(createElement(UserInputPanel, { pending, onResolve }));

    expect(view.lastFrame()).toContain('SQLite (Recommended)');
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Review'));
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({
        status: 'submitted',
        answers: [{ questionId: 'storage', selected: ['SQLite'] }],
      }),
    );
    view.unmount();
  });

  it('收集 Other 自由文本并作为结构化答案提交', async () => {
    const onResolve = vi.fn(async () => undefined);
    const view = render(createElement(UserInputPanel, { pending, onResolve }));

    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'JSONL')).toContain('›'),
    );
    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'Other...')).toContain('›'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('Describe your answer'),
    );
    view.stdin.write('Postgres');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Postgres'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Review'));
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({
        status: 'submitted',
        answers: [
          {
            questionId: 'storage',
            selected: ['Other'],
            otherText: 'Postgres',
          },
        ],
      }),
    );
    view.unmount();
  });

  it('多选问题用空格切换选项并用回车确认', async () => {
    const onResolve = vi.fn(async () => undefined);
    const multiPending: UserInputRequest = {
      ...pending,
      params: {
        ...pending.params,
        questions: [{ ...pending.params.questions[0]!, multiple: true }],
      },
    };
    const view = render(
      createElement(UserInputPanel, { pending: multiPending, onResolve }),
    );

    view.stdin.write(' ');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'SQLite')).toContain('[x]'),
    );
    view.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'JSONL')).toContain('›'),
    );
    view.stdin.write(' ');
    await vi.waitFor(() =>
      expect(selectedLine(view.lastFrame(), 'JSONL')).toContain('[x]'),
    );
    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Review'));
    view.stdin.write('\r');

    await vi.waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({
        status: 'submitted',
        answers: [{ questionId: 'storage', selected: ['SQLite', 'JSONL'] }],
      }),
    );
    view.unmount();
  });

  it('支持把复核结果转为继续对话或明确拒绝', async () => {
    const chat = vi.fn(async () => undefined);
    const chatView = render(
      createElement(UserInputPanel, { pending, onResolve: chat }),
    );
    chatView.stdin.write('\r');
    await vi.waitFor(() => expect(chatView.lastFrame()).toContain('Review'));
    chatView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(chatView.lastFrame(), 'Chat about this')).toContain(
        '›',
      ),
    );
    chatView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(chatView.lastFrame()).not.toContain('Review'),
    );
    chatView.stdin.write('Explain the tradeoff');
    await vi.waitFor(() =>
      expect(chatView.lastFrame()).toContain('Explain the tradeoff'),
    );
    chatView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(chat).toHaveBeenCalledWith({
        status: 'chat',
        message: 'Explain the tradeoff',
      }),
    );
    chatView.unmount();

    const deny = vi.fn(async () => undefined);
    const denyView = render(
      createElement(UserInputPanel, { pending, onResolve: deny }),
    );
    denyView.stdin.write('\r');
    await vi.waitFor(() => expect(denyView.lastFrame()).toContain('Review'));
    denyView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(denyView.lastFrame(), 'Chat about this')).toContain(
        '›',
      ),
    );
    denyView.stdin.write('\u001b[B');
    await vi.waitFor(() =>
      expect(selectedLine(denyView.lastFrame(), 'Deny')).toContain('›'),
    );
    denyView.stdin.write('\r');
    await vi.waitFor(() =>
      expect(deny).toHaveBeenCalledWith({ status: 'denied' }),
    );
    denyView.unmount();
  });

  it('提交失败时展示错误，并允许用户重试同一决议', async () => {
    const onResolve = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue(undefined);
    const view = render(createElement(UserInputPanel, { pending, onResolve }));

    view.stdin.write('\r');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Review'));
    view.stdin.write('\r');
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain('network unavailable'),
    );
    view.stdin.write('\r');

    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledTimes(2));
    view.unmount();
  });
});

function selectedLine(frame: string | undefined, value: string): string {
  return frame?.split('\n').find((line) => line.includes(value)) ?? '';
}
