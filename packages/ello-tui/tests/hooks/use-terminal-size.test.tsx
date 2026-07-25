import { EventEmitter } from 'node:events';

import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { useTerminalSize } from '../../src/tui/hooks/use-terminal-size.js';

class ResizeableStdout extends EventEmitter {
  columns: number | undefined;

  write = (): boolean => true;

  constructor(columns: number | undefined) {
    super();
    this.columns = columns;
  }
}

function SizeProbe({
  onColumns,
}: {
  readonly onColumns: (columns: number) => void;
}) {
  onColumns(useTerminalSize().columns);
  return null;
}

function renderProbe(
  stdout: ResizeableStdout,
  onColumns: (columns: number) => void,
) {
  return render(
    createElement(SizeProbe, { onColumns }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
}

// Ink mounts synchronously, but a state update scheduled from a native resize
// listener is flushed on a later macrotask. Yield once so React commits the
// resize-triggered re-render before the assertions run.
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useTerminalSize', () => {
  it('uses stdout columns initially and updates after resize', async () => {
    const stdout = new ResizeableStdout(120);
    const columns: number[] = [];
    const view = renderProbe(stdout, (count) => columns.push(count));

    expect(columns.at(-1)).toBe(120);

    stdout.columns = 40;
    stdout.emit('resize');
    await nextTick();

    expect(columns.at(-1)).toBe(40);
    view.unmount();
  });

  it('falls back to 100 columns and removes its resize listener on unmount', async () => {
    const stdout = new ResizeableStdout(undefined);
    const columns: number[] = [];
    const view = renderProbe(stdout, (count) => columns.push(count));

    expect(columns.at(-1)).toBe(100);

    // Ink itself listens to resize on the injected stdout, so this hook's
    // listener is layered on top of it. After unmount both must be gone.
    expect(stdout.listenerCount('resize')).toBeGreaterThan(0);

    view.unmount();

    const before = columns.length;
    stdout.columns = 25;
    stdout.emit('resize');
    await nextTick();

    // No leak: after unmount, resize no longer reaches this hook.
    expect(columns).toHaveLength(before);
    expect(stdout.listenerCount('resize')).toBe(0);
  });
});
