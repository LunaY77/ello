import { describe, expect, it } from 'vitest';

import { JsonlFramer } from './jsonl-framer';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('JsonlFramer', () => {
  it('整帧直接产出', () => {
    const framer = new JsonlFramer();
    const frames = framer.push(encoder.encode('{"a":1}\n{"b":2}\n'));
    expect(frames.map((f) => decoder.decode(f))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('跨 chunk 的残帧被缓冲拼合', () => {
    const framer = new JsonlFramer();
    expect(framer.push(encoder.encode('{"a":1'))).toEqual([]);
    expect(framer.push(encoder.encode(',"b":2}\n'))).toHaveLength(1);
    const frames = framer.push(encoder.encode('{"c":3}\n'));
    expect(frames.map((f) => decoder.decode(f))).toEqual(['{"c":3}']);
  });

  it('多字节字符跨 chunk 边界不损坏', () => {
    const framer = new JsonlFramer();
    const bytes = encoder.encode('{"text":"你好"}\n');
    const cut = 12; // 落在多字节序列中间
    expect(framer.push(bytes.subarray(0, cut))).toEqual([]);
    const frames = framer.push(bytes.subarray(cut));
    expect(decoder.decode(frames[0] ?? new Uint8Array())).toBe('{"text":"你好"}');
  });

  it('transport 关闭时残留半帧直接抛错', () => {
    const framer = new JsonlFramer();
    framer.push(encoder.encode('{"a":1'));
    expect(() => framer.flush()).toThrow();
  });

  it('无残留时 flush 为空', () => {
    const framer = new JsonlFramer();
    framer.push(encoder.encode('{"a":1}\n'));
    expect(framer.flush()).toEqual([]);
  });
});
