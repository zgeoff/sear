import { Box, Text } from 'ink';

export type ConfirmationPromptProps = {
  message: string;
};

export function ConfirmationPrompt({ message }: ConfirmationPromptProps) {
  return (
    <Box>
      <Text>{message}</Text>
    </Box>
  );
}
