/**
 * 桌面 transport:经 Tauri command 启动打包的 ello-agent sidecar,
 * 通过 Tauri Channel 双向转发 newline-delimited JSON-RPC。
 * bridge 只转发完整 frame 与进程生命周期事件,不解析 method、不修改 payload。
 * sidecar 缺失、提前退出或输出非法 frame 时,messages() 迭代以 TransportClosedError 终止。
 */
import { Channel, invoke } from '@tauri-apps/api/core';

import { AsyncByteQueue, TransportClosedError, type AppTransport } from '../transport.js';

/** 与 src-tauri SidecarEvent 的 serde(tag = "event") 一一对应。 */
type SidecarEvent =
  | { readonly event: 'frame'; readonly data: string }
  | { readonly event: 'stderr'; readonly data: string }
  | { readonly event: 'exit'; readonly data: { readonly code: number | null } };

const encoder = new TextEncoder();

export class DesktopSidecarTransport implements AppTransport {
  readonly kind = 'desktop-sidecar' as const;

  private readonly incoming = new AsyncByteQueue();
  private readonly channel = new Channel<SidecarEvent>();
  private closed = false;
  private started = false;

  constructor() {
    this.channel.onmessage = (event) => this.handleEvent(event);
  }

  /** 启动 sidecar 进程;重复启动直接抛错。 */
  async start(): Promise<void> {
    if (this.started) {
      throw new Error('Sidecar transport is already started.');
    }
    this.started = true;
    try {
      await invoke('sidecar_start', { onEvent: this.channel });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new TransportClosedError(
        `Failed to start the bundled ello-agent sidecar: ${cause}`,
        { cause: error },
      );
    }
  }

  messages(): AsyncIterable<Uint8Array> {
    return this.incoming;
  }

  async send(message: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new TransportClosedError('Sidecar transport is closed.');
    }
    await invoke('sidecar_send', {
      frame: new TextDecoder().decode(message),
    });
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.incoming.end();
    await invoke('sidecar_kill', { reason });
  }

  private handleEvent(event: SidecarEvent): void {
    switch (event.event) {
      case 'frame':
        if (!this.incoming.push(encoder.encode(event.data))) {
          void this.close('Inbound frame queue is full.').catch((error: unknown) => {
            this.incoming.fail(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
        }
        return;
      case 'stderr':
        // sidecar 的诊断输出不属于协议流;交给 dev 控制台排查。
        console.error('[ello-agent]', event.data);
        return;
      case 'exit':
        if (this.closed) return;
        this.incoming.fail(
          new TransportClosedError(
            `ello-agent sidecar exited unexpectedly (code ${String(event.data.code)}).`,
          ),
        );
        return;
    }
  }
}
