import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, test } from 'vitest';
import { ConfirmationPrompt } from './confirmation-prompt.tsx';

function renderPrompt(message: string): ReturnType<typeof render> {
  return render(
    <Box width={80} height={24}>
      <ConfirmationPrompt message={message} terminalWidth={80} terminalHeight={24} />
    </Box>,
  );
}

test('it renders the confirmation message text', () => {
  const { lastFrame } = renderPrompt('Dispatch Implementor for #5?');

  expect(lastFrame()).toContain('Dispatch Implementor for #5?');
});

test('it renders the y/n response hint', () => {
  const { lastFrame } = renderPrompt('Cancel agent for #3?');

  expect(lastFrame()).toContain('[y/n]');
});

test('it renders a bordered overlay', () => {
  const { lastFrame } = renderPrompt('Quit?');

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Quit?');
  expect(frame).toContain('[y/n]');
  // Ink border characters should be present
  expect(frame).toContain('─');
  expect(frame).toContain('│');
});
