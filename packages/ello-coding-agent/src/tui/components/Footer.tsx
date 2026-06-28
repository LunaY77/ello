import { Box, Text } from 'ink';

import type { FooterView } from '../state/selectors.js';

/** 低频动态状态栏。 */
export function Footer({ view }: { readonly view: FooterView }) {
  return (
    <Box justifyContent="space-between" borderStyle="single" paddingX={1} marginTop={1}>
      <Text color="gray">{view.cwd}</Text>
      <Text>{`${view.model}  ${view.mode}`}</Text>
    </Box>
  );
}
