import { render } from 'ink-testing-library';
import { expect, test } from 'vitest';
import { ConfirmationPrompt } from './confirmation-prompt';

test('it renders the confirmation message', () => {
  const { lastFrame } = render(<ConfirmationPrompt message="Dispatch Implementor for #5? [y/n]" />);

  expect(lastFrame()).toContain('Dispatch Implementor for #5? [y/n]');
});

test('it renders a different confirmation message', () => {
  const { lastFrame } = render(<ConfirmationPrompt message="Cancel agent for #3? [y/n]" />);

  expect(lastFrame()).toContain('Cancel agent for #3? [y/n]');
});
