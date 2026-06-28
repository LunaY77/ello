import { TextInput } from '@inkjs/ui';
import { Box, Text } from 'ink';

export interface ComposerProps {
  /** 是否运行中：决定回车语义是 steer 还是 submit。 */
  readonly running: boolean;
  /** overlay 抢焦点时置 false，输入被忽略。 */
  readonly isActive?: boolean;
  /** `/`、`@` 补全建议。 */
  readonly suggestions?: readonly string[];
  onSubmit(value: string): void;
}

/**
 * 输入区。
 *
 * 用 `@inkjs/ui` 的 {@link TextInput} 替换旧的手搓 `useInput` 字符拼接：
 * 回车提交，运行中提交即 steer、空闲提交即新一轮 submit（由 App 区分）。
 */
export function Composer(props: ComposerProps) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text color="cyan">{'>'}</Text>
        <TextInput
          isDisabled={props.isActive === false}
          placeholder={props.running ? 'steer while running…' : '/command  @file  !shell'}
          {...(props.suggestions !== undefined ? { suggestions: [...props.suggestions] } : {})}
          onSubmit={props.onSubmit}
        />
      </Box>
      <Text dimColor>
        {props.running
          ? 'Enter steers the running turn · Esc aborts'
          : 'Enter submits · /command · @file · !shell'}
      </Text>
    </Box>
  );
}
