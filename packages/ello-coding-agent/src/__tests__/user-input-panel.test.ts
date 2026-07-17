import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { UserInputPanel } from '../tui/component/UserInputPanel.js';

const pending = {
  toolCallId: 'ask-1',
  request: {
    questions: [
      {
        id: 'storage',
        header: 'Storage',
        question: 'Which storage?',
        options: [
          { label: 'SQLite', description: 'Recommended locally.' },
          { label: 'JSONL', description: 'Append-only.' },
        ],
        multiSelect: false,
      },
    ],
  },
} as const;

describe('UserInputPanel', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('submits a recommended single selection', async () => {
    const onResolve = vi.fn(async () => {});
    const view = render(createElement(UserInputPanel, { pending, onResolve }));
    expect(view.lastFrame()).toContain('SQLite (Recommended)');
    view.stdin.write('\r');
    await flush();
    expect(view.lastFrame()).toContain('Review');
    view.stdin.write('\r');
    await flush();
    expect(onResolve).toHaveBeenCalledWith({
      status: 'submitted',
      answers: [{ questionId: 'storage', selected: ['SQLite'] }],
    });
    view.unmount();
  });

  it('collects Other text before review', async () => {
    const onResolve = vi.fn(async () => {});
    const view = render(createElement(UserInputPanel, { pending, onResolve }));
    view.stdin.write('\u001b[B');
    await flush();
    view.stdin.write('\u001b[B');
    await flush();
    expect(view.lastFrame()).toContain('Other...');
    view.stdin.write('\r');
    await flush();
    view.stdin.write('Postgres');
    view.stdin.write('\r');
    await flush();
    view.stdin.write('\r');
    await flush();
    expect(onResolve).toHaveBeenCalledWith({
      status: 'submitted',
      answers: [
        {
          questionId: 'storage',
          selected: ['Other'],
          otherText: 'Postgres',
        },
      ],
    });
    view.unmount();
  });

  it('toggles multiple selections with Space and confirms with Enter', async () => {
    const onResolve = vi.fn(async () => {});
    const multiPending = {
      ...pending,
      request: {
        questions: [{ ...pending.request.questions[0], multiSelect: true }],
      },
    } as const;
    const view = render(
      createElement(UserInputPanel, { pending: multiPending, onResolve }),
    );
    view.stdin.write(' ');
    await flush();
    view.stdin.write('\u001b[B');
    await flush();
    view.stdin.write(' ');
    await flush();
    view.stdin.write('\r');
    await flush();
    view.stdin.write('\r');
    await flush();
    expect(onResolve).toHaveBeenCalledWith({
      status: 'submitted',
      answers: [{ questionId: 'storage', selected: ['SQLite', 'JSONL'] }],
    });
    view.unmount();
  });

  it('returns chat and deny as explicit resolutions', async () => {
    const chat = vi.fn(async () => {});
    const chatView = render(
      createElement(UserInputPanel, { pending, onResolve: chat }),
    );
    chatView.stdin.write('\r');
    await flush();
    chatView.stdin.write('\u001b[B');
    await flush();
    chatView.stdin.write('\r');
    await flush();
    chatView.stdin.write('Explain the tradeoff');
    chatView.stdin.write('\r');
    await flush();
    expect(chat).toHaveBeenCalledWith({
      status: 'chat',
      message: 'Explain the tradeoff',
    });
    chatView.unmount();

    const deny = vi.fn(async () => {});
    const denyView = render(
      createElement(UserInputPanel, { pending, onResolve: deny }),
    );
    denyView.stdin.write('\r');
    await flush();
    denyView.stdin.write('\u001b[B');
    await flush();
    denyView.stdin.write('\u001b[B');
    await flush();
    denyView.stdin.write('\r');
    await flush();
    expect(deny).toHaveBeenCalledWith({ status: 'denied' });
    denyView.unmount();
  });
});
