import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

export interface ConfirmationPromptProps {
  message: string;
  terminalWidth: number;
  terminalHeight: number;
}

const CONTENT_PADDING = 4;
const BORDER_WIDTH = 2;
const PROMPT_HEIGHT = 4;
const CENTER_DIVISOR = 2;

export function ConfirmationPrompt(props: ConfirmationPromptProps): ReactNode {
  const contentWidth = props.message.length + CONTENT_PADDING;
  const boxWidth = contentWidth + BORDER_WIDTH;
  const leftOffset = Math.max(0, Math.floor((props.terminalWidth - boxWidth) / CENTER_DIVISOR));
  const topOffset = Math.max(
    0,
    Math.floor((props.terminalHeight - PROMPT_HEIGHT) / CENTER_DIVISOR),
  );

  return (
    <Box
      position="absolute"
      marginLeft={leftOffset}
      marginTop={topOffset}
      flexDirection="column"
      borderStyle="single"
      width={boxWidth}
    >
      <Box justifyContent="center" paddingX={1}>
        <Text>{props.message}</Text>
      </Box>
      <Box justifyContent="center" paddingX={1}>
        <Text>[y/n]</Text>
      </Box>
    </Box>
  );
}
