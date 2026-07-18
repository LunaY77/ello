import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Composer } from '../tui/component/Composer.js';

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
});
