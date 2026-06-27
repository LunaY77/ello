import { Box, Text } from 'ink';
import React from 'react';

/**
 * 渲染当前模型和模型切换提示。
 */
export function ModelPicker(props: {
  models: string[];
  selectedIndex: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text color="cyan">model</Text>
      {props.models.map((model, index) => (
        <Text key={model} color={index === props.selectedIndex ? 'yellow' : 'white'}>
          {`${index === props.selectedIndex ? '> ' : '  '}${model}`}
        </Text>
      ))}
      <Text color="gray">up/down select, enter switch, /model name for direct switch.</Text>
    </Box>
  );
}
