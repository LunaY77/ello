import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/Button';

/**
 * 最近的 Error Boundary:协议/渲染错误直接可见,保留完整错误文本。
 * 不吞错、不降级成空页面。
 */
export class ErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ello-app] render failure', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-lg font-semibold text-danger">界面渲染失败</div>
        <pre className="max-w-xl overflow-auto rounded-lg border border-border-subtle bg-surface-2 p-3 text-left font-mono text-xs whitespace-pre-wrap text-secondary">
          {error.message}
          {'\n'}
          {error.stack ?? ''}
        </pre>
        <Button variant="secondary" onClick={() => this.setState({ error: null })}>
          重试渲染
        </Button>
      </div>
    );
  }
}
