import { Box, Text } from 'ink';

export type ConfirmationPromptProps = {
  message: string;
};

export function ConfirmationPrompt(props: ConfirmationPromptProps) {
  return (
    <Box>
      <Text>{props.message}</Text>
    </Box>
  );
}
