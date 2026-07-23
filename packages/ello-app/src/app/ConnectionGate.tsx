import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';

import { startSession } from '@/client/session';
import { Button } from '@/components/ui/Button';
import { runOperation } from '@/lib/report';
import { isTauri } from '@/lib/tauri/bridge';
import { useAppStore } from '@/store/store';

/**
 * 连接门禁:连接就绪前所有路由都经过这里。
 * fatal 直接展示完整错误;桌面构建只启用 DesktopSidecarTransport,
 * sidecar 失败不会自动改连远端。
 */
export function ConnectionGate(props: { readonly children: React.ReactNode }) {
  const phase = useAppStore((s) => s.connection.phase);
  const fatalError = useAppStore((s) => s.connection.fatalError);

  if (phase === 'ready') return <>{props.children}</>;

  if (phase === 'fatal') {
    return (
      <GateShell>
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-danger-subtle text-danger">
          <TriangleAlert size={22} />
        </div>
        <div className="text-[16px] font-semibold">连接已断开</div>
        <pre className="max-w-lg overflow-auto rounded-lg border border-border-subtle bg-surface-2 p-3 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-secondary">
          {fatalError ?? '未知错误'}
        </pre>
        <Button
          variant="primary"
          icon={<RefreshCw size={14} />}
          onClick={() => void runOperation(startSession())}
        >
          重新连接
        </Button>
      </GateShell>
    );
  }

  if (phase === 'idle' && !isTauri()) {
    return (
      <GateShell>
        <div className="text-[16px] font-semibold">需要桌面运行时</div>
        <p className="max-w-sm text-center text-[12.5px] leading-5 text-tertiary">
          ello 通过 Tauri 启动内置 ello-agent sidecar。请使用
          <code className="mx-1 rounded bg-surface-2 px-1 font-mono">pnpm tauri dev</code>
          启动应用,而不是在浏览器中打开。
        </p>
      </GateShell>
    );
  }

  return (
    <GateShell>
      <LoaderCircle size={22} className="animate-spin-slow text-fluent" />
      <div className="text-[13px] text-tertiary">
        {phase === 'handshake' ? '正在与 ello-agent 握手…' : '正在启动 ello-agent…'}
      </div>
    </GateShell>
  );
}

function GateShell(props: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-8">
      <div className="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#2b9fff] to-[#005a9e] text-[28px] font-bold text-white shadow-2 dark:from-[#60cdff] dark:to-[#106ebe] dark:text-[#0a1a26]">
        e
      </div>
      {props.children}
    </div>
  );
}
