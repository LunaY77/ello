import { EventEmitter } from 'node:events';

import { render } from 'ink-testing-library';
import StdoutContext from 'ink/build/components/StdoutContext.js';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { useTerminalSize } from '../../src/tui/hooks/use-terminal-size.js';

class ResizeableStdout extends EventEmitter {
  columns: number | undefined;

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
    createElement(
      StdoutContext.Provider,
      {
        value: {
          stdout: stdout as unknown as NodeJS.WriteStream,
          write: () => {},
        },
      },
      createElement(SizeProbe, { onColumns }),
    ),
  );
}

describe('useTerminalSize', () => {
  it('uses stdout columns initially and updates after resize', () => {
    const stdout = new ResizeableStdout(120);
    const columns: number[] = [];
    const view = renderProbe(stdout, (columnCount) => columns.push(columnCount));

    stdout.columns = 40;
    stdout.emit('resize');

    expect(columns).toEqual([120, 40]);
    view.unmount();
  });

  it('falls back to 100 columns and removes its resize listener on unmount', () => {
    const stdout = new ResizeableStdout(undefined);
    const columns: number[] = [];
    const view = renderProbe(stdout, (columnCount) => columns.push(columnCount));

    expect(columns).toEqual([100]);
    expect(stdout.listenerCount('resize')).toBe(1);

    view.unmount();

    expect(stdout.listenerCount('resize')).toBe(0);
  });
});
