import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { validateBashCommand } from './validate-bash-command.ts';

export function createBashValidatorHook(): HookCallback {
  return async (
    input: HookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    const command = extractCommand(input);

    if (command === '') {
      return { decision: 'approve' };
    }

    const result = validateBashCommand(command);

    if (result.allowed) {
      return { decision: 'approve' };
    }

    return { decision: 'block', reason: result.reason };
  };
}

function extractCommand(input: HookInput): string {
  if (!('tool_input' in input) || input.tool_input === null) {
    return '';
  }
  if (typeof input.tool_input !== 'object') {
    return '';
  }
  const toolInput = input.tool_input as Record<string, unknown>;
  if (typeof toolInput.command !== 'string') {
    return '';
  }
  return toolInput.command;
}
