import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const FALLBACK: TerminalSize = { columns: 100, rows: 24 };

/**
 * 订阅 stdout resize 的终端尺寸。
 *
 * Ink 不提供尺寸 hook，直接在渲染里读 `stdout.columns` 会在窗口缩放后停留在旧值：
 * 布局、Composer 可用宽度和 live 区行数预算都会算错。
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

  useEffect(() => {
    const onResize = (): void => {
      setSize((current) => {
        const next = readSize(stdout);
        return next.columns === current.columns && next.rows === current.rows
          ? current
          : next;
      });
    };
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}

function readSize(stdout: NodeJS.WriteStream): TerminalSize {
  return {
    columns: positive(stdout.columns) ?? FALLBACK.columns,
    rows: positive(stdout.rows) ?? FALLBACK.rows,
  };
}

/**
 * `??` 不拦 0，而 `stdout.rows` 在 pty 尺寸未协商好时确实会是 0。
 * 用 0 当高度会让行数预算退化，footer 在 0 列下换行成上百行，画面直接崩掉。
 */
function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}
