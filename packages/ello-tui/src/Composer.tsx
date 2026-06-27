import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import React from 'react';

import { composerRows, resolveComposerSubmit } from './composer-input.js';

/**
 * TUI 使用的受控多行 prompt composer。
 *
 * Enter 用于提交；当终端上报修饰键时，Shift+Enter 或 Meta+Enter 插入换行；
 * Enter 前的结尾反斜杠作为兼容终端的兜底换行方式保留。
 */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void | Promise<void>;
  mode?: 'normal' | 'history';
  focus?: boolean;
}) {
  const rows = composerRows(props.value);
  const committedRows = rows.slice(0, -1);
  const currentRow = rows.at(-1) ?? '';

  function joinCurrentRow(value: string): string {
    return [...committedRows, value].join('\n');
  }

  function handleChange(value: string): void {
    props.onChange(joinCurrentRow(value));
  }

  function handleSubmit(value: string): void {
    const result = resolveComposerSubmit(joinCurrentRow(value));
    if (!result.submitted) {
      props.onChange(result.value);
      return;
    }
    void props.onSubmit(result.value);
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color={props.mode === 'history' ? 'yellow' : 'green'}>
        {props.mode === 'history' ? 'history' : 'composer'}
      </Text>
      {committedRows.map((row, index) => (
        <Text key={`${index}:${row}`} color="gray">
          {row}
        </Text>
      ))}
      <TextInput
        value={currentRow}
        onChange={handleChange}
        onSubmit={handleSubmit}
        focus={props.focus ?? true}
      />
    </Box>
  );
}
