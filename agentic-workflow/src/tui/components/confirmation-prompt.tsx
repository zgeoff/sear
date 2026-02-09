import { Box, Text } from 'ink';

export type ConfirmationPromptProps = {
  message: string;
  terminalWidth: number;
  terminalHeight: number;
};

export function ConfirmationPrompt(props: ConfirmationPromptProps) {
  const contentWidth = props.message.length + 4;
  const boxWidth = contentWidth + 2;
  const leftOffset = Math.max(0, Math.floor((props.terminalWidth - boxWidth) / 2));
  const topOffset = Math.max(0, Math.floor((props.terminalHeight - 4) / 2));

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
