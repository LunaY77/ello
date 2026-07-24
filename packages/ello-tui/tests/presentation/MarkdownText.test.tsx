import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { MarkdownText } from '../../src/tui/utils/markdown/MarkdownText.js';

describe('MarkdownText', () => {
  it('渲染 heading 内容', () => {
    const frame = render(<MarkdownText text="# Hello" />)?.lastFrame() ?? '';
    expect(frame).toContain('Hello');
    expect(frame).not.toContain('# Hello');
  });

  it('streaming prop 透传，未闭合 fence 不崩', () => {
    const frame =
      render(
        <MarkdownText text={'# H\n\n```ts\nconst'} streaming />,
      )?.lastFrame() ?? '';
    expect(frame).toContain('const');
  });

  it('默认按完整文本渲染', () => {
    const frame =
      render(<MarkdownText text="plain paragraph" />)?.lastFrame() ?? '';
    expect(frame).toContain('plain paragraph');
  });

  it('空文本渲染为空', () => {
    expect(render(<MarkdownText text="" />)?.lastFrame() ?? '').toBe('');
  });
});
