import { expect, test, vi } from 'vitest';
import type { EngineCommand } from '../../types.ts';
import { createCommandDispatcher } from './create-command-dispatcher.ts';
import type { CommandHandlers } from './types.ts';

function setupTest(): {
  handlers: CommandHandlers;
  dispatcher: ReturnType<typeof createCommandDispatcher>;
} {
  const handlers: CommandHandlers = {
    dispatchImplementor: vi.fn(),
    dispatchReviewer: vi.fn(),
    cancelAgent: vi.fn(),
    cancelPlanner: vi.fn(),
    shutdown: vi.fn(),
  };
  const dispatcher = createCommandDispatcher(handlers);
  return { handlers, dispatcher };
}

test('it routes a dispatch-implementor command to the correct handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'dispatchImplementor',
    issueNumber: 42,
  };

  dispatcher.dispatch(command);
  expect(handlers.dispatchImplementor).toHaveBeenCalledWith(command);
  expect(handlers.dispatchImplementor).toHaveBeenCalledTimes(1);
});

test('it routes a dispatch-reviewer command to the correct handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'dispatchReviewer',
    issueNumber: 7,
  };

  dispatcher.dispatch(command);
  expect(handlers.dispatchReviewer).toHaveBeenCalledWith(command);
  expect(handlers.dispatchReviewer).toHaveBeenCalledTimes(1);
});

test('it routes a cancel-agent command to the correct handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'cancelAgent',
    issueNumber: 15,
  };

  dispatcher.dispatch(command);
  expect(handlers.cancelAgent).toHaveBeenCalledWith(command);
  expect(handlers.cancelAgent).toHaveBeenCalledTimes(1);
});

test('it routes a cancel-planner command to the correct handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'cancelPlanner',
  };

  dispatcher.dispatch(command);
  expect(handlers.cancelPlanner).toHaveBeenCalledWith(command);
  expect(handlers.cancelPlanner).toHaveBeenCalledTimes(1);
});

test('it routes a shutdown command to the correct handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'shutdown',
  };

  dispatcher.dispatch(command);
  expect(handlers.shutdown).toHaveBeenCalledWith(command);
  expect(handlers.shutdown).toHaveBeenCalledTimes(1);
});

test('it routes each command type to its own handler exclusively', () => {
  const { handlers, dispatcher } = setupTest();

  dispatcher.dispatch({ command: 'dispatchImplementor', issueNumber: 1 });

  expect(handlers.dispatchImplementor).toHaveBeenCalledTimes(1);
  expect(handlers.dispatchReviewer).not.toHaveBeenCalled();
  expect(handlers.cancelAgent).not.toHaveBeenCalled();
  expect(handlers.cancelPlanner).not.toHaveBeenCalled();
  expect(handlers.shutdown).not.toHaveBeenCalled();
});

test('it handles all command types without errors', () => {
  const { handlers, dispatcher } = setupTest();

  const commands: EngineCommand[] = [
    { command: 'dispatchImplementor', issueNumber: 1 },
    { command: 'dispatchReviewer', issueNumber: 2 },
    { command: 'cancelAgent', issueNumber: 3 },
    { command: 'cancelPlanner' },
    { command: 'shutdown' },
  ];

  for (const command of commands) {
    dispatcher.dispatch(command);
  }

  expect(handlers.dispatchImplementor).toHaveBeenCalledTimes(1);
  expect(handlers.dispatchReviewer).toHaveBeenCalledTimes(1);
  expect(handlers.cancelAgent).toHaveBeenCalledTimes(1);
  expect(handlers.cancelPlanner).toHaveBeenCalledTimes(1);
  expect(handlers.shutdown).toHaveBeenCalledTimes(1);
});

test('it passes the full command object to the matched handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'cancelAgent',
    issueNumber: 99,
  };

  dispatcher.dispatch(command);

  expect(handlers.cancelAgent).toHaveBeenCalledWith({
    command: 'cancelAgent',
    issueNumber: 99,
  });
});
