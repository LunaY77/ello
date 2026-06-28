import { Box, Text, useInput } from 'ink';

export interface ComposerProps {
  readonly value: string;
  readonly running: boolean;
  readonly isActive?: boolean;
  onChange(value: string): void;
  onSubmit(value: string): void;
  onFollowUp?(value: string): void;
}

/** 多行 composer 的轻量控制器。 */
export function Composer(props: ComposerProps) {
  useInput((input, key) => {
    if (key.shift && key.return) {
      props.onChange(`${props.value}\n`);
      return;
    }
    if (key.meta && key.return) {
      props.onFollowUp?.(props.value);
      return;
    }
    if (key.return) {
      props.onSubmit(props.value);
      return;
    }
    if (key.backspace || key.delete) {
      props.onChange(props.value.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'c') {
      props.onChange('');
      return;
    }
    if (input) {
      props.onChange(`${props.value}${input}`);
    }
  }, { isActive: props.isActive ?? true });
  return (
    <Box flexDirection="column" borderStyle={props.isActive === false ? 'single' : 'double'} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color="cyan">Composer</Text>
        <Text dimColor>{props.running ? 'steer mode' : 'submit mode'}</Text>
      </Box>
      <Text wrap="wrap">{props.value ? `> ${props.value}` : '> '}</Text>
      <Text dimColor>{props.running ? 'Enter steer while running  Alt+Enter follow-up  Esc abort' : 'Enter submit  /command  @file  !shell'}</Text>
    </Box>
  );
}
