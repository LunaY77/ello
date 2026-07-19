import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from '../../src/tui/component/Composer.js';

describe('Composer', () => {
  it('deletes the previous character when terminal backspace is sent as DEL', async () => {
    const changes: string[] = [];
    const view = render(
      createElement(Composer, {
        running: false,
        onChange: (value: string) => changes.push(value),
        onSubmit: () => {},
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('abc');
    view.stdin.write('\x7f');

    expect(changes.at(-1)).toBe('ab');
    view.unmount();
  });

  it('deletes the previous character when terminal backspace is sent as BS', async () => {
    const changes: string[] = [];
    const view = render(
      createElement(Composer, {
        running: false,
        onChange: (value: string) => changes.push(value),
        onSubmit: () => {},
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('abc');
    view.stdin.write('\b');

    expect(changes.at(-1)).toBe('ab');
    view.unmount();
  });

  it('keeps multiline input navigable and submits all lines', () => {
    const submitted: string[] = [];
    const view = render(
      createElement(Composer, {
        running: false,
        onSubmit: (value: string) => submitted.push(value),
        onChange: () => {},
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('one\\');
    view.stdin.write('\r');
    view.stdin.write('two\\');
    view.stdin.write('\r');
    view.stdin.write('three');
    view.stdin.write('\u001b[A');
    view.stdin.write('\u001b[A');
    view.stdin.write('\r');

    expect(submitted.at(-1)).toBe('one\ntwo\nthree');
    view.unmount();
  });

  it('wraps long pasted text visually and accepts Shift+Enter', () => {
    const changes: Array<{
      readonly value: string;
      readonly cursor: { readonly line: number; readonly column: number };
    }> = [];
    const view = render(
      createElement(Composer, {
        running: false,
        onSubmit: () => {},
        onChange: (
          value: string,
          cursor: { readonly line: number; readonly column: number },
        ) => changes.push({ value, cursor }),
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    const pasted = 'x'.repeat(100);
    view.stdin.write(pasted);
    view.stdin.write('\u001b[A');

    expect(changes.at(-1)).toEqual({
      value: pasted,
      cursor: { line: 0, column: 10 },
    });
    view.stdin.write('\u001b[13;2u');
    view.stdin.write('line');
    expect(changes.at(-1)?.value).toBe(
      `${pasted.slice(0, 10)}\nline${pasted.slice(10)}`,
    );
    view.unmount();
  });

  it('does not insert terminal mouse tracking sequences into the input', () => {
    const changes: string[] = [];
    const view = render(
      createElement(Composer, {
        running: false,
        onSubmit: () => {},
        onChange: (value: string) => changes.push(value),
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('\u001b[<64;10;5M');
    view.stdin.write('\u001b[<0;10;5M');
    view.stdin.write('a');

    expect(changes).toEqual(['a']);
    view.unmount();
  });

  it('accepts file suggestions by replacing only the active @ token', () => {
    const changes: string[] = [];
    const view = render(
      createElement(Composer, {
        running: false,
        suggestions: ['@tmp'],
        onSubmit: () => {},
        onChange: (value: string) => changes.push(value),
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('change @tm');
    view.stdin.write('\t');

    expect(changes.at(-1)).toBe('change @tmp');
    view.unmount();
  });

  it('prioritizes interrupting a running thread over clearing the draft', () => {
    const changes: string[] = [];
    const onCancel = vi.fn();
    const view = render(
      createElement(Composer, {
        running: true,
        onSubmit: () => {},
        onChange: (value: string) => changes.push(value),
        onCancel,
        onEscape: () => {},
      }),
    );

    view.stdin.write('keep this draft');
    view.stdin.write('\x03');

    expect(onCancel).toHaveBeenCalledOnce();
    expect(changes.at(-1)).toBe('keep this draft');
    view.unmount();
  });

  it('clears a draft before delegating Ctrl+C as an exit request', () => {
    const changes: string[] = [];
    const onCancel = vi.fn();
    const view = render(
      createElement(Composer, {
        running: false,
        onSubmit: () => {},
        onChange: (value: string) => changes.push(value),
        onCancel,
        onEscape: () => {},
      }),
    );

    view.stdin.write('clear this draft');
    view.stdin.write('\x03');

    expect(changes.at(-1)).toBe('');
    expect(onCancel).not.toHaveBeenCalled();
    view.stdin.write('\x03');
    expect(onCancel).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('switches through input history with Up and Down', () => {
    const changes: string[] = [];
    const view = render(
      createElement(Composer, {
        running: false,
        history: ['oldest input', 'newest input'],
        onSubmit: () => {},
        onChange: (value: string) => changes.push(value),
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('\u001b[A');
    view.stdin.write('\u001b[A');
    view.stdin.write('\u001b[B');
    view.stdin.write('\u001b[B');

    expect(changes).toEqual([
      'newest input',
      'oldest input',
      'newest input',
      '',
    ]);
    view.unmount();
  });

  it('keeps browsing history when recalled input has suggestions', () => {
    const changes: string[] = [];
    const composerProps = {
      running: false,
      history: ['older input', '/settings'],
      onSubmit: () => {},
      onChange: (value: string) => changes.push(value),
      onCancel: () => {},
      onEscape: () => {},
    };
    const view = render(createElement(Composer, composerProps));

    view.stdin.write('\u001b[A');
    view.rerender(
      createElement(Composer, {
        ...composerProps,
        suggestions: ['/settings'],
      }),
    );
    view.stdin.write('\u001b[A');

    expect(changes).toEqual(['/settings', 'older input']);
    view.unmount();
  });

  it('uses Up and Down for multiline cursor movement before history', () => {
    const changes: Array<{
      readonly value: string;
      readonly cursor: { readonly line: number; readonly column: number };
    }> = [];
    const view = render(
      createElement(Composer, {
        running: false,
        history: ['historical input'],
        onSubmit: () => {},
        onChange: (
          value: string,
          cursor: { readonly line: number; readonly column: number },
        ) => changes.push({ value, cursor }),
        onCancel: () => {},
        onEscape: () => {},
      }),
    );

    view.stdin.write('first\\');
    view.stdin.write('\r');
    view.stdin.write('second');
    view.stdin.write('\u001b[A');

    expect(changes.at(-1)).toEqual({
      value: 'first\nsecond',
      cursor: { line: 0, column: 5 },
    });
    view.stdin.write('\u001b[B');
    expect(changes.at(-1)?.cursor).toEqual({ line: 1, column: 5 });
    expect(changes.at(-1)?.value).toBe('first\nsecond');
    view.unmount();
  });
});
