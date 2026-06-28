declare module 'ink' {
  import type { ReactNode } from 'react';

  export interface BoxProps {
    readonly children?: ReactNode;
    readonly flexDirection?: 'row' | 'column';
    readonly width?: string | number;
    readonly justifyContent?: string;
    readonly borderStyle?: string;
    readonly paddingX?: number;
    readonly marginTop?: number;
    readonly marginBottom?: number;
  }

  export interface TextProps {
    readonly children?: ReactNode;
    readonly color?: string;
    readonly dimColor?: boolean;
    readonly wrap?: 'wrap' | 'truncate' | 'truncate-middle' | 'truncate-start' | 'truncate-end';
  }

  export function Box(props: BoxProps): ReactNode;
  export function Text(props: TextProps): ReactNode;
  export function Static<T>(props: { readonly items: readonly T[]; readonly children: (item: T, index: number) => ReactNode }): ReactNode;
  export function useInput(handler: (input: string, key: Record<string, boolean>) => void, options?: { readonly isActive?: boolean }): void;
  export function useApp(): { readonly exit: () => void; readonly suspendTerminal: (callback: () => void) => void };
  export function useStdout(): { readonly stdout: { readonly columns?: number; readonly rows?: number } };
  export function render(node: ReactNode, options?: { readonly maxFps?: number }): { waitUntilExit(): Promise<void>; unmount(): void };
}
