import { render } from 'ink-testing-library';
import React from 'react';
import { expect, test, vi } from 'vitest';
import type { Engine, EngineCommand, EngineEvent, StartupResult } from '../types';
import { App } from './app';

type EventHandler = (event: EngineEvent) => void;

type MockEngineResult = {
  engine: Engine;
  emit: (event: EngineEvent) => void;
  sentCommands: EngineCommand[];
  resolveStart: (result: StartupResult) => void;
  rejectStart: (error: Error) => void;
  waitForStartCalled: () => Promise<void>;
};

function createMockEngine(): MockEngineResult {
  const handlers: EventHandler[] = [];
  const sentCommands: EngineCommand[] = [];
  let resolveStart: (result: StartupResult) => void = () => {};
  let rejectStart: (error: Error) => void = () => {};
  let resolveStartCalled: () => void = () => {};
  const startCalledPromise = new Promise<void>((resolve) => {
    resolveStartCalled = resolve;
  });

  const engine: Engine = {
    start: vi.fn(
      () =>
        new Promise<StartupResult>((resolve, reject) => {
          resolveStart = resolve;
          rejectStart = reject;
          resolveStartCalled();
        }),
    ),
    on(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    send(command) {
      sentCommands.push(command);
    },
    getIssueDetails: vi.fn(() =>
      Promise.resolve({
        number: 1,
        title: 'Test',
        body: 'body',
        labels: ['task:implement'],
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ),
    getPRForIssue: vi.fn(() =>
      Promise.resolve({
        number: 10,
        title: 'PR Title',
        changedFilesCount: 3,
        ciStatus: 'success' as const,
        url: 'https://github.com/owner/repo/pull/10',
      }),
    ),
    getAgentStream: vi.fn(() => null),
  };

  function emit(event: EngineEvent) {
    for (const handler of handlers) {
      handler(event);
    }
  }

  return {
    engine,
    emit,
    sentCommands,
    resolveStart: (result) => resolveStart(result),
    rejectStart: (error) => rejectStart(error),
    waitForStartCalled: () => startCalledPromise,
  };
}

function setupTest() {
  const mock = createMockEngine();
  const instance = render(<App engine={mock.engine} repository="owner/repo" />);
  return { ...mock, ...instance };
}

async function setupStartedTest(startupResult?: StartupResult) {
  const result = setupTest();
  await result.waitForStartCalled();
  result.resolveStart(startupResult ?? { issueCount: 0, recoveriesPerformed: 0 });
  await vi.waitFor(() => {
    expect(result.lastFrame()).toContain('Notifications');
  });
  return result;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

test('it shows a loading indicator while the engine is starting', () => {
  const { lastFrame } = setupTest();

  expect(lastFrame()).toContain('Starting engine...');
});

test('it renders the three-pane layout after startup completes', async () => {
  const { lastFrame, resolveStart, waitForStartCalled } = setupTest();

  await waitForStartCalled();
  resolveStart({ issueCount: 5, recoveriesPerformed: 0 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Notifications');
    expect(frame).toContain('Issue List');
    expect(frame).toContain('Detail Pane');
  });
});

test('it displays a startup summary notification after startup completes', async () => {
  const { lastFrame, resolveStart, waitForStartCalled } = setupTest();

  await waitForStartCalled();
  resolveStart({ issueCount: 3, recoveriesPerformed: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Startup complete: 3 issues');
    expect(frame).toContain('1 recoveries performed');
  });
});

test('it omits the recovery count in the startup summary when none were performed', async () => {
  const { lastFrame, resolveStart, waitForStartCalled } = setupTest();

  await waitForStartCalled();
  resolveStart({ issueCount: 7, recoveriesPerformed: 0 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Startup complete: 7 issues');
    expect(frame).toContain('tracked');
    expect(frame).not.toContain('recoveries performed');
  });
});

test('it shows an error message when startup fails', async () => {
  const { lastFrame, rejectStart, waitForStartCalled } = setupTest();

  await waitForStartCalled();
  rejectStart(new Error('connection refused'));

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Startup failed: connection refused');
  });
});

// ---------------------------------------------------------------------------
// Layout — Focus
// ---------------------------------------------------------------------------

test('it highlights the issue list pane on initial render', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame();
  expect(frame).toContain('Issue List');
  expect(frame).toContain('Detail Pane');
  expect(frame).toContain('Notifications');
});

test('it shows placeholder content in the issue list pane', async () => {
  const { lastFrame } = await setupStartedTest();

  expect(lastFrame()).toContain('No issues tracked');
});

test('it shows placeholder content in the detail pane', async () => {
  const { lastFrame } = await setupStartedTest();

  expect(lastFrame()).toContain('No issue selected');
});

// ---------------------------------------------------------------------------
// Focus cycling
// ---------------------------------------------------------------------------

test('it moves focus forward through the pane cycle when Tab is pressed', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('\t');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Detail Pane');
  });
});

test('it moves focus backward through the pane cycle when Shift+Tab is pressed', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('\x1b[Z');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Notifications');
  });
});

// ---------------------------------------------------------------------------
// Quit confirmation
// ---------------------------------------------------------------------------

test('it shows a quit prompt without agent count when no agents are running', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });
});

test('it shows a quit prompt with agent count when agents are running', async () => {
  const { lastFrame, stdin, emit } = await setupStartedTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Test',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? 1 agent(s) running. [y/n]');
  });
});

test('it dismisses the quit prompt when the user presses n', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('n');

  await vi.waitFor(() => {
    expect(lastFrame()).not.toContain('Quit?');
  });
});

test('it dismisses the quit prompt when the user presses Escape', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('\x1b');

  await vi.waitFor(() => {
    expect(lastFrame()).not.toContain('Quit?');
  });
});

test('it sends the shutdown command when the user confirms quit', async () => {
  const { lastFrame, stdin, sentCommands } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(sentCommands).toContainEqual({ command: 'shutdown' });
    expect(lastFrame()).toContain('Shutting down');
  });
});

test('it ignores Enter while the quit prompt is displayed', async () => {
  const { lastFrame, stdin, sentCommands } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('\r');

  // The prompt should still be visible — Enter is ignored
  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  expect(sentCommands).not.toContainEqual({ command: 'shutdown' });
});

test('it ignores q while the quit prompt is displayed', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('q');

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Quit? [y/n]');
  });
});

// ---------------------------------------------------------------------------
// Shutdown display
// ---------------------------------------------------------------------------

test('it shows the shutdown status with agent count while shutting down', async () => {
  const { lastFrame, stdin, emit } = await setupStartedTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Test',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit?');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Shutting down... waiting for 1 agent(s)');
  });
});

test('it exits the app when all agents complete during shutdown', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Shutting down... waiting for 0 agent(s)');
  });
});

// ---------------------------------------------------------------------------
// Prompt exclusivity
// ---------------------------------------------------------------------------

test('it ignores Tab while the quit prompt is active', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });

  stdin.write('\t');

  // Prompt is still active — Tab was ignored
  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit? [y/n]');
  });
});
