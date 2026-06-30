import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Composer } from '../tui/components/Composer.js';

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
});
