import { useInput, type Key } from 'ink';
import { useCallback, useLayoutEffect, useRef } from 'react';

/** Ink input handler 保持稳定引用，同时始终调用最新闭包，避免重复订阅终端输入。 */
export function useStableInput(
  handler: (input: string, key: Key) => void,
): void {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  const stableHandler = useCallback((input: string, key: Key): void => {
    handlerRef.current(input, key);
  }, []);
  useInput(stableHandler, { isActive: true });
}
