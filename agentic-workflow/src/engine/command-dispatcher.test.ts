import { expect, test, vi } from 'vitest';
import type { EngineCommand } from '../types.js';
import { type CommandHandlers, createCommandDispatcher } from './command-dispatcher.js';

function setupTest() {
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

test('dispatchImplementor command invokes the dispatchImplementor handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'dispatchImplementor',
    issueNumber: 42,
  };

  dispatcher.dispatch(command);
  expect(handlers.dispatchImplementor).toHaveBeenCalledWith(command);
  expect(handlers.dispatchImplementor).toHaveBeenCalledTimes(1);
});

test('dispatchReviewer command invokes the dispatchReviewer handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'dispatchReviewer',
    issueNumber: 7,
  };

  dispatcher.dispatch(command);
  expect(handlers.dispatchReviewer).toHaveBeenCalledWith(command);
  expect(handlers.dispatchReviewer).toHaveBeenCalledTimes(1);
});

test('cancelAgent command invokes the cancelAgent handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'cancelAgent',
    issueNumber: 15,
  };

  dispatcher.dispatch(command);
  expect(handlers.cancelAgent).toHaveBeenCalledWith(command);
  expect(handlers.cancelAgent).toHaveBeenCalledTimes(1);
});

test('cancelPlanner command invokes the cancelPlanner handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'cancelPlanner',
  };

  dispatcher.dispatch(command);
  expect(handlers.cancelPlanner).toHaveBeenCalledWith(command);
  expect(handlers.cancelPlanner).toHaveBeenCalledTimes(1);
});

test('shutdown command invokes the shutdown handler', () => {
  const { handlers, dispatcher } = setupTest();

  const command: EngineCommand = {
    command: 'shutdown',
  };

  dispatcher.dispatch(command);
  expect(handlers.shutdown).toHaveBeenCalledWith(command);
  expect(handlers.shutdown).toHaveBeenCalledTimes(1);
});

test('each command type routes to its own handler exclusively', () => {
  const { handlers, dispatcher } = setupTest();

  dispatcher.dispatch({ command: 'dispatchImplementor', issueNumber: 1 });

  expect(handlers.dispatchImplementor).toHaveBeenCalledTimes(1);
  expect(handlers.dispatchReviewer).not.toHaveBeenCalled();
  expect(handlers.cancelAgent).not.toHaveBeenCalled();
  expect(handlers.cancelPlanner).not.toHaveBeenCalled();
  expect(handlers.shutdown).not.toHaveBeenCalled();
});

test('dispatcher handles all EngineCommand types', () => {
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

test('dispatcher passes full command object to handler', () => {
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
