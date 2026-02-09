import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { expect, test } from 'vitest';
import { createBashValidatorHook } from './create-bash-validator-hook.ts';

interface HookOptions {
  signal: AbortSignal;
}

function setupTest(): { hook: ReturnType<typeof createBashValidatorHook>; options: HookOptions } {
  const hook = createBashValidatorHook();
  const options: HookOptions = { signal: AbortSignal.abort() };
  return { hook, options };
}

function buildHookInput(command: string | undefined): HookInput {
  return {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: command !== undefined ? { command } : {},
    tool_use_id: 'tool-1',
  };
}

test('it approves a command with an allowlisted prefix', async () => {
  const { hook, options } = setupTest();
  const input = buildHookInput('git status');
  const result = await hook(input, 'tool-1', options);
  expect(result).toStrictEqual({ decision: 'approve' });
});

test('it blocks a command matching a blocklist pattern', async () => {
  const { hook, options } = setupTest();
  const input = buildHookInput('rm -rf /tmp/dir');
  const result = await hook(input, 'tool-1', options);
  expect(result).toStrictEqual({
    decision: 'block',
    reason: "Blocked: matches dangerous pattern 'rm\\s'",
  });
});

test('it blocks a command with an unrecognized prefix', async () => {
  const { hook, options } = setupTest();
  const input = buildHookInput('python3 --version');
  const result = await hook(input, 'tool-1', options);
  expect(result).toStrictEqual({
    decision: 'block',
    reason: "Blocked: 'python3' is not in the allowed command list",
  });
});

test('it approves when the command is an empty string', async () => {
  const { hook, options } = setupTest();
  const input = buildHookInput('');
  const result = await hook(input, 'tool-1', options);
  expect(result).toStrictEqual({ decision: 'approve' });
});

test('it approves when the command field is missing from tool input', async () => {
  const { hook, options } = setupTest();
  const input = buildHookInput(undefined);
  const result = await hook(input, undefined, options);
  expect(result).toStrictEqual({ decision: 'approve' });
});

test('it approves when tool input is null', async () => {
  const { hook, options } = setupTest();
  const input: HookInput = {
    session_id: 'test-session',
    transcript_path: '/tmp/transcript',
    cwd: '/tmp',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: null,
    tool_use_id: 'tool-1',
  };
  const result = await hook(input, undefined, options);
  expect(result).toStrictEqual({ decision: 'approve' });
});
