import { useStdout } from 'ink';
import { useEffect, useState } from 'react';

export interface TerminalSize {
  readonly columns: number;
}

function columnsFor(stdout: NodeJS.WriteStream): number {
  return stdout.columns ?? 100;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(() => columnsFor(stdout));

  useEffect(() => {
    const onResize = (): void => {
      setColumns(columnsFor(stdout));
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return { columns };
}
