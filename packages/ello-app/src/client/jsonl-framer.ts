/**
 * newline-delimited JSON 帧切分。stdio sidecar 上一条消息一行;
 * 输出 chunk 可能跨帧,framer 必须缓冲残帧。非法 UTF-8 直接抛错(fail fast)。
 */
const NEWLINE = 0x0a;

export class JsonlFramer {
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  /** 喂入原始字节,产出 0..n 条完整帧(不含换行)。 */
  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== NEWLINE) continue;
      const segment = chunk.subarray(start, index);
      frames.push(this.assemble(segment));
      start = index + 1;
    }
    if (start < chunk.length) {
      this.pending.push(chunk.subarray(start));
      this.pendingBytes += chunk.length - start;
    }
    return frames;
  }

  /** transport 关闭时冲刷;残留半帧视为对端违约。 */
  flush(): Uint8Array[] {
    if (this.pendingBytes === 0) return [];
    throw new Error('Transport closed with a partial JSONL frame buffered.');
  }

  private assemble(tail: Uint8Array): Uint8Array {
    if (this.pending.length === 0) return tail;
    const frame = new Uint8Array(this.pendingBytes + tail.length);
    let offset = 0;
    for (const part of this.pending) {
      frame.set(part, offset);
      offset += part.length;
    }
    frame.set(tail, offset);
    this.pending = [];
    this.pendingBytes = 0;
    // 用 fatal decoder 验证一次,尽早暴露截断的多字节字符。
    this.decoder.decode(frame);
    return frame;
  }
}
