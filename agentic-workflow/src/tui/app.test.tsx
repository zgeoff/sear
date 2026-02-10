import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import type { StartupResult } from '../types.ts';
import { App, computeAutoScrollOffset, computePaneWidths } from './app.tsx';
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
    expect(frame).toContain('Startup complete');
  });
});

test('it displays a startup notification in the notifications pane after startup completes', async () => {
  const { lastFrame, resolveStart, waitForStartCalled } = setupTest();

  await waitForStartCalled();
  resolveStart({ issueCount: 3, recoveriesPerformed: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Startup complete');
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

  // Select the first issue while focus is on issue list (detail pane shows selected issue)
  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('No issue selected');
    expect(frame).toContain('#1 First');
  });

  // Move focus away from issue list to detail pane
  stdin.write('\t');

  // Allow focus change to take effect
  await new Promise((r) => setTimeout(r, 50));

  // Pressing j should NOT change issue selection since focus moved to detail pane
  stdin.write('j');

  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1 First');
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

  // Select the first issue while focus is on issue list (detail pane shows selected issue)
  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('No issue selected');
    expect(frame).toContain('#1 First');
  });

  // Move focus backward from issue list to notifications
  stdin.write('\x1b[Z');

  // Allow focus change to take effect
  await new Promise((r) => setTimeout(r, 50));

  // Pressing j should NOT change issue selection since focus moved to notifications
  stdin.write('j');

  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1 First');
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

// ---------------------------------------------------------------------------
// Border rendering
// ---------------------------------------------------------------------------

test('it renders box-drawing border characters around the panes', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame() ?? '';
  expect(frame).toContain('\u250c');
  expect(frame).toContain('\u252c');
  expect(frame).toContain('\u2510');
  expect(frame).toContain('\u2502');
  expect(frame).toContain('\u2514');
  expect(frame).toContain('\u2534');
  expect(frame).toContain('\u2518');
  expect(frame).toContain('\u2500');
});

test('it embeds pane labels in full caps in the top border', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame() ?? '';
  const firstLine = frame.split('\n')[0] ?? '';
  expect(firstLine).toContain('NOTIFICATIONS');
  expect(firstLine).toContain('ISSUES');
  expect(firstLine).toContain('DETAILS');
});

test('it renders labels with a gap after the corner or junction character', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame() ?? '';
  const firstLine = frame.split('\n')[0] ?? '';
  expect(firstLine).toContain('\u250c NOTIFICATIONS');
  expect(firstLine).toContain('\u252c ISSUES');
  expect(firstLine).toContain('\u252c DETAILS');
});

test('it renders vertical dividers in the content area', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame() ?? '';
  expect(frame).toContain('\u2502');
});

test('it renders the bottom border with junction characters', async () => {
  const { lastFrame } = await setupStartedTest();

  const frame = lastFrame() ?? '';
  const lines = frame.split('\n');
  const lastLine = lines.at(-1) ?? '';
  expect(lastLine).toContain('\u2514');
  expect(lastLine).toContain('\u2534');
  expect(lastLine).toContain('\u2518');
});

// ---------------------------------------------------------------------------
// Pane width calculation
// ---------------------------------------------------------------------------

test('it computes equal pane widths when terminal width divides evenly', () => {
  const widths = computePaneWidths(82);
  expect(widths[0]).toBe(26);
  expect(widths[1]).toBe(26);
  expect(widths[2]).toBe(26);
  expect(widths[0] + widths[1] + widths[2] + 4).toBe(82);
});

test('it allocates remainder columns to the rightmost pane', () => {
  const widths = computePaneWidths(80);
  expect(widths[0]).toBe(25);
  expect(widths[1]).toBe(25);
  expect(widths[2]).toBe(26);
  expect(widths[0] + widths[1] + widths[2] + 4).toBe(80);
});

test('it accounts for exactly four border columns', () => {
  const widths = computePaneWidths(120);
  expect(widths[0] + widths[1] + widths[2] + 4).toBe(120);
});

// ---------------------------------------------------------------------------
// Auto-scroll offset computation
// ---------------------------------------------------------------------------

test('it keeps the viewport at the top when the scroll offset is zero', () => {
  const result = computeAutoScrollOffset(0, 22);

  expect(result).toBe(0);
});

test('it resets the viewport to the top when within one page of the top', () => {
  const visibleItemCount = 22;
  const result = computeAutoScrollOffset(10, visibleItemCount);

  expect(result).toBe(0);
});

test('it resets the viewport to the top when the offset is one less than the visible count', () => {
  const visibleItemCount = 22;
  const result = computeAutoScrollOffset(21, visibleItemCount);

  expect(result).toBe(0);
});

test('it increments the viewport offset when past one page', () => {
  const visibleItemCount = 22;
  const result = computeAutoScrollOffset(22, visibleItemCount);

  expect(result).toBe(23);
});

test('it increments the viewport offset when well past one page', () => {
  const visibleItemCount = 22;
  const result = computeAutoScrollOffset(50, visibleItemCount);

  expect(result).toBe(51);
});

// ---------------------------------------------------------------------------
// Auto-scroll integration
// ---------------------------------------------------------------------------

test('it keeps the newest notification visible when the viewport is at the top', async () => {
  const { lastFrame, emit } = await setupStartedTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 42,
    title: 'Test issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#42');
  });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 43,
    title: 'Second issue',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-02T00:00:00Z',
  });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#43');
    expect(frame).toContain('#42');
  });
});
