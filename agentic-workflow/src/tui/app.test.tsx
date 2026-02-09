import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import type { StartupResult } from '../types.ts';
import { App } from './app.tsx';
import { createMockEngine } from './test-utils/create-mock-engine.ts';

interface DeferredStartResult {
  resolveStart: (result: StartupResult) => void;
  rejectStart: (error: Error) => void;
  waitForStartCalled: () => Promise<void>;
}

function createDeferredStart(): DeferredStartResult & { start: () => Promise<StartupResult> } {
  let resolveStart: (result: StartupResult) => void = () => {
    /* noop placeholder */
  };
  let rejectStart: (error: Error) => void = () => {
    /* noop placeholder */
  };
  let resolveStartCalled: () => void = () => {
    /* noop placeholder */
  };
  const startCalledPromise = new Promise<void>((resolve) => {
    resolveStartCalled = resolve;
  });

  const start = vi.fn(
    () =>
      new Promise<StartupResult>((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
        resolveStartCalled();
      }),
  );

  return {
    start,
    resolveStart: (result: StartupResult) => resolveStart(result),
    rejectStart: (error: Error) => rejectStart(error),
    waitForStartCalled: () => startCalledPromise,
  };
}

function setupTest(): ReturnType<typeof createMockEngine> &
  DeferredStartResult &
  ReturnType<typeof render> & { start: () => Promise<StartupResult> } {
  const deferred = createDeferredStart();
  const mock = createMockEngine({ start: deferred.start });
  const instance = render(<App engine={mock.engine} repository="owner/repo" />);
  return { ...mock, ...deferred, ...instance };
}

async function setupStartedTest(
  startupResult?: StartupResult,
): Promise<ReturnType<typeof setupTest>> {
  const result = setupTest();
  await result.waitForStartCalled();
  result.resolveStart(startupResult ?? { issueCount: 0, recoveriesPerformed: 0 });
  await vi.waitFor(() => {
    expect(result.lastFrame()).toContain('No issues tracked');
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
    expect(frame).toContain('No issues tracked');
    expect(frame).toContain('No issue selected');
    expect(frame).toContain('Startup complete: 5 issues');
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

test('it renders all three panes on initial startup', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame();
  expect(frame).toContain('NOTIFICATIONS');
  expect(frame).toContain('No issues tracked');
  expect(frame).toContain('No issue selected');
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
  const { lastFrame, stdin, emit } = await setupStartedTest();

  // Add two issues so j navigation is possible
  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'First',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });
  emit({
    type: 'issueStatusChanged',
    issueNumber: 2,
    title: 'Second',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-02T00:00:00Z',
  });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  // Select the first issue while focus is on issue list
  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('> ');
  });

  // Move focus away from issue list to detail pane
  stdin.write('\t');

  // Allow focus change to take effect
  await new Promise((r) => setTimeout(r, 50));

  // Pressing j should NOT change issue selection since focus moved to detail pane
  stdin.write('j');

  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  const lines = frame.split('\n');
  const selectedLine = lines.find((l) => l.includes('> '));
  expect(selectedLine).toContain('#1');
});

test('it moves focus backward through the pane cycle when Shift+Tab is pressed', async () => {
  const { lastFrame, stdin, emit } = await setupStartedTest();

  // Add two issues so j navigation is possible
  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'First',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });
  emit({
    type: 'issueStatusChanged',
    issueNumber: 2,
    title: 'Second',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-02T00:00:00Z',
  });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  // Select the first issue while focus is on issue list
  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('> ');
  });

  // Move focus backward from issue list to notifications
  stdin.write('\x1b[Z');

  // Allow focus change to take effect
  await new Promise((r) => setTimeout(r, 50));

  // Pressing j should NOT change issue selection since focus moved to notifications
  stdin.write('j');

  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  const lines = frame.split('\n');
  const selectedLine = lines.find((l) => l.includes('> '));
  expect(selectedLine).toContain('#1');
});

// ---------------------------------------------------------------------------
// Quit confirmation
// ---------------------------------------------------------------------------

test('it shows a quit prompt without agent count when no agents are running', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Quit?');
    expect(frame).toContain('[y/n]');
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
    const frame = lastFrame();
    expect(frame).toContain('Quit? 1 agent(s) running.');
    expect(frame).toContain('[y/n]');
  });
});

test('it dismisses the quit prompt when the user presses n', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit?');
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
    expect(lastFrame()).toContain('Quit?');
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
    expect(lastFrame()).toContain('Quit?');
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
    expect(lastFrame()).toContain('Quit?');
  });

  stdin.write('\r');

  // The prompt should still be visible — Enter is ignored
  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit?');
  });

  expect(sentCommands).not.toContainEqual({ command: 'shutdown' });
});

test('it ignores q while the quit prompt is displayed', async () => {
  const { lastFrame, stdin } = await setupStartedTest();

  stdin.write('q');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit?');
  });

  stdin.write('q');

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Quit?');
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
    expect(lastFrame()).toContain('Quit?');
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
    expect(lastFrame()).toContain('Quit?');
  });

  stdin.write('\t');

  // Prompt is still active — Tab was ignored
  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Quit?');
  });
});
