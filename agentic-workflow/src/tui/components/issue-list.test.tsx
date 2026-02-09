import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import type { Engine, EngineCommand, EngineEvent } from '../../types.ts';
import { createEngineStore } from '../store.ts';
import type { CachedPRDetails } from '../types.ts';
import { IssueList } from './issue-list.tsx';

type EventHandler = (event: EngineEvent) => void;

function createMockEngine(): {
  engine: Engine;
  emit: (event: EngineEvent) => void;
  sentCommands: EngineCommand[];
} {
  const handlers: EventHandler[] = [];
  const sentCommands: EngineCommand[] = [];

  const engine: Engine = {
    start: vi.fn(async () => ({ issueCount: 0, recoveriesPerformed: 0 })),
    on(handler: EventHandler): () => void {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) {
          handlers.splice(idx, 1);
        }
      };
    },
    send(command: EngineCommand): void {
      sentCommands.push(command);
    },
    getIssueDetails: vi.fn(async () => ({
      number: 1,
      title: 'Test',
      body: 'body',
      labels: ['task:implement'],
      createdAt: '2026-01-01T00:00:00Z',
    })),
    getPRForIssue: vi.fn(async () => ({
      number: 10,
      title: 'PR Title',
      changedFilesCount: 3,
      ciStatus: 'success' as const,
      url: 'https://github.com/owner/repo/pull/10',
    })),
    getAgentStream: vi.fn(() => null),
  };

  function emit(event: EngineEvent): void {
    for (const handler of handlers) {
      handler(event);
    }
  }

  return { engine, emit, sentCommands };
}

interface SetupTestConfig {
  focused?: boolean;
  height?: number;
}

function setupTest(config?: SetupTestConfig): ReturnType<typeof render> & {
  store: ReturnType<typeof createEngineStore>;
  emit: (event: EngineEvent) => void;
  sentCommands: EngineCommand[];
  onOpenURL: ReturnType<typeof vi.fn>;
  engine: Engine;
  onPromptChange: ReturnType<typeof vi.fn>;
} {
  const { engine, emit, sentCommands } = createMockEngine();
  const store = createEngineStore({ engine, repository: 'owner/repo' });
  const onOpenUrl = vi.fn();
  const focused = config?.focused ?? true;
  const height = config?.height ?? 20;

  const onPromptChange = vi.fn();

  const instance = render(
    <IssueList
      store={store}
      focused={focused}
      onOpenURL={onOpenUrl}
      repository="owner/repo"
      height={height}
      promptActive={false}
      onPromptChange={onPromptChange}
    />,
  );

  return { ...instance, store, emit, sentCommands, onOpenURL: onOpenUrl, engine, onPromptChange };
}

interface AddIssueOverrides {
  title?: string;
  status?: string;
  priority?: string;
  createdAt?: string;
}

function addIssue(
  emit: (event: EngineEvent) => void,
  issueNumber: number,
  overrides?: AddIssueOverrides,
): void {
  emit({
    type: 'issueStatusChanged',
    issueNumber,
    title: overrides?.title ?? `Issue ${issueNumber}`,
    oldStatus: null,
    newStatus: overrides?.status ?? 'pending',
    priorityLabel: overrides?.priority ?? 'priority:medium',
    createdAt: overrides?.createdAt ?? '2026-01-01T00:00:00Z',
  });
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test('it displays an empty state message when no issues are tracked', () => {
  const { lastFrame } = setupTest();

  expect(lastFrame()).toContain('No issues tracked');
});

// ---------------------------------------------------------------------------
// Rendering issues
// ---------------------------------------------------------------------------

test('it displays each issue with priority, number, title, and state indicator', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 5, { title: 'My feature', status: 'pending', priority: 'priority:high' });
  store.getState().selectIssue(5);

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('!!!');
    expect(frame).toContain('#5');
    expect(frame).toContain('My feature');
    expect(frame).toContain('[READY]');
  });
});

// ---------------------------------------------------------------------------
// State indicators
// ---------------------------------------------------------------------------

test('it shows a ready marker for pending issues', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'pending' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[READY]');
  });
});

test('it shows a ready marker for unblocked issues', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'unblocked' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[READY]');
  });
});

test('it shows a ready marker for needs-changes issues', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'needs-changes' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[READY]');
  });
});

test('it shows a spinner indicator for issues with a running agent', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[RUNNING]');
  });
});

test('it shows a review marker for review issues without a running agent', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'review' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[REVIEW]');
  });
});

test('it shows a blocked marker for needs-refinement issues', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'needs-refinement' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[BLOCKED]');
  });
});

test('it shows a blocked marker for blocked issues', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'blocked' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[BLOCKED]');
  });
});

test('it shows a done marker for approved issues', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'approved' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[DONE]');
  });
});

test('it shows an error marker when an issue has a failure regardless of status', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'crash',
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('[ERROR]');
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('it pins issues with running agents to the top of the list', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { title: 'Alpha', status: 'pending', priority: 'priority:high' });
  addIssue(emit, 2, { title: 'Beta', status: 'in-progress', priority: 'priority:low' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 2,
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const betaIndex = frame.indexOf('Beta');
    const alphaIndex = frame.indexOf('Alpha');
    expect(betaIndex).toBeGreaterThan(-1);
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeLessThan(alphaIndex);
  });
});

test('it orders issues by priority within the same running state', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { title: 'Low', status: 'pending', priority: 'priority:low' });
  addIssue(emit, 2, { title: 'High', status: 'pending', priority: 'priority:high' });
  addIssue(emit, 3, { title: 'Med', status: 'pending', priority: 'priority:medium' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const highIndex = frame.indexOf('High');
    const medIndex = frame.indexOf('Med');
    const lowIndex = frame.indexOf('Low');
    expect(highIndex).toBeLessThan(medIndex);
    expect(medIndex).toBeLessThan(lowIndex);
  });
});

test('it orders issues by creation date within the same priority', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, {
    title: 'Newer',
    status: 'pending',
    priority: 'priority:medium',
    createdAt: '2026-02-01T00:00:00Z',
  });
  addIssue(emit, 2, {
    title: 'Older',
    status: 'pending',
    priority: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const olderIndex = frame.indexOf('Older');
    const newerIndex = frame.indexOf('Newer');
    expect(olderIndex).toBeLessThan(newerIndex);
  });
});

// ---------------------------------------------------------------------------
// Navigation — j/k and arrow keys
// ---------------------------------------------------------------------------

test('it moves the selection down when j is pressed', async () => {
  const { lastFrame, emit, store, stdin } = setupTest();

  addIssue(emit, 1, { title: 'First' });
  addIssue(emit, 2, { title: 'Second', createdAt: '2026-01-02T00:00:00Z' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#2');
  });
});

test('it moves the selection up when k is pressed', async () => {
  const { lastFrame, emit, store, stdin } = setupTest();

  addIssue(emit, 1, { title: 'First' });
  addIssue(emit, 2, { title: 'Second', createdAt: '2026-01-02T00:00:00Z' });
  store.getState().selectIssue(2);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#2');
  });

  stdin.write('k');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#1');
  });
});

test('it moves the selection down when the down arrow is pressed', async () => {
  const { lastFrame, emit, store, stdin } = setupTest();

  addIssue(emit, 1, { title: 'First' });
  addIssue(emit, 2, { title: 'Second', createdAt: '2026-01-02T00:00:00Z' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  stdin.write('\x1b[B');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#2');
  });
});

test('it moves the selection up when the up arrow is pressed', async () => {
  const { lastFrame, emit, store, stdin } = setupTest();

  addIssue(emit, 1, { title: 'First' });
  addIssue(emit, 2, { title: 'Second', createdAt: '2026-01-02T00:00:00Z' });
  store.getState().selectIssue(2);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#2');
  });

  stdin.write('\x1b[A');

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#1');
  });
});

test('it does not move past the end of the list when pressing down', async () => {
  const { lastFrame, emit, store, stdin } = setupTest();

  addIssue(emit, 1, { title: 'Only' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  stdin.write('j');

  // Wait a tick and ensure selection didn't change
  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  const lines = frame.split('\n');
  const selectedLine = lines.find((l) => l.includes('> '));
  expect(selectedLine).toContain('#1');
});

test('it does not move past the beginning of the list when pressing up', async () => {
  const { lastFrame, emit, store, stdin } = setupTest();

  addIssue(emit, 1, { title: 'Only' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  stdin.write('k');

  // Wait a tick and ensure selection didn't change
  await new Promise((r) => setTimeout(r, 50));

  const frame = lastFrame() ?? '';
  const lines = frame.split('\n');
  const selectedLine = lines.find((l) => l.includes('> '));
  expect(selectedLine).toContain('#1');
});

// ---------------------------------------------------------------------------
// Enter — dispatch confirmation for dispatchable issues
// ---------------------------------------------------------------------------

test('it shows a dispatch confirmation when Enter is pressed on a pending issue', async () => {
  const { lastFrame, emit, store, stdin, onPromptChange } = setupTest();

  addIssue(emit, 5, { status: 'pending' });
  store.getState().selectIssue(5);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#5');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Dispatch Implementor for #5?');
  });
});

test('it dispatches an implementor when the dispatch confirmation is accepted', async () => {
  const { lastFrame, emit, store, stdin, sentCommands, onPromptChange } = setupTest();

  addIssue(emit, 5, { status: 'pending' });
  store.getState().selectIssue(5);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#5');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Dispatch Implementor for #5?');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(sentCommands).toContainEqual({ command: 'dispatchImplementor', issueNumber: 5 });
  });
});

test('it dismisses the dispatch confirmation when the user presses n', async () => {
  const { lastFrame, emit, store, stdin, sentCommands, onPromptChange } = setupTest();

  addIssue(emit, 5, { status: 'pending' });
  store.getState().selectIssue(5);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#5');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Dispatch Implementor for #5?');
  });

  onPromptChange.mockClear();
  stdin.write('n');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith(null);
  });
  expect(sentCommands).not.toContainEqual({ command: 'dispatchImplementor', issueNumber: 5 });
});

test('it dismisses the dispatch confirmation when the user presses Escape', async () => {
  const { lastFrame, emit, store, stdin, sentCommands, onPromptChange } = setupTest();

  addIssue(emit, 5, { status: 'pending' });
  store.getState().selectIssue(5);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#5');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Dispatch Implementor for #5?');
  });

  onPromptChange.mockClear();
  stdin.write('\x1b');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith(null);
  });
  expect(sentCommands).not.toContainEqual({ command: 'dispatchImplementor', issueNumber: 5 });
});

// ---------------------------------------------------------------------------
// Enter — cancel confirmation for running agents
// ---------------------------------------------------------------------------

test('it shows a cancel confirmation when Enter is pressed on an issue with a running agent', async () => {
  const { lastFrame, emit, store, stdin, onPromptChange } = setupTest();

  addIssue(emit, 3, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 3,
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(3);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#3');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Cancel agent for #3?');
  });
});

test('it sends a cancel command when the cancel confirmation is accepted', async () => {
  const { lastFrame, emit, store, stdin, sentCommands, onPromptChange } = setupTest();

  addIssue(emit, 3, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 3,
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(3);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#3');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Cancel agent for #3?');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(sentCommands).toContainEqual({ command: 'cancelAgent', issueNumber: 3 });
  });
});

// ---------------------------------------------------------------------------
// Enter — retry confirmation for failed issues
// ---------------------------------------------------------------------------

test('it shows a retry confirmation when Enter is pressed on a failed issue', async () => {
  const { lastFrame, emit, store, stdin, onPromptChange } = setupTest();

  addIssue(emit, 7, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 7,
    sessionID: 'sess-1',
  });
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 7,
    error: 'crash',
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(7);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#7');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Retry Implementor for #7?');
  });
});

test('it dispatches the appropriate agent and clears the failure when retry is confirmed', async () => {
  const { lastFrame, emit, store, stdin, sentCommands, onPromptChange } = setupTest();

  addIssue(emit, 7, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 7,
    sessionID: 'sess-1',
  });
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 7,
    error: 'crash',
    sessionID: 'sess-1',
  });
  store.getState().selectIssue(7);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#7');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Retry Implementor for #7?');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(sentCommands).toContainEqual({ command: 'dispatchImplementor', issueNumber: 7 });
    expect(store.getState().issues.get(7)?.lastFailure).toBeUndefined();
  });
});

test('it shows the correct agent type in the retry prompt for reviewer failures', async () => {
  const { lastFrame, emit, store, stdin, onPromptChange } = setupTest();

  addIssue(emit, 7, { status: 'review' });
  emit({
    type: 'agentStarted',
    agentType: 'reviewer',
    issueNumber: 7,
    sessionID: 'sess-r-1',
  });
  emit({
    type: 'agentFailed',
    agentType: 'reviewer',
    issueNumber: 7,
    error: 'review crash',
    sessionID: 'sess-r-1',
  });
  store.getState().selectIssue(7);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#7');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Retry Reviewer for #7?');
  });
});

test('it dispatches a reviewer when retrying a failed reviewer', async () => {
  const { lastFrame, emit, store, stdin, sentCommands, onPromptChange } = setupTest();

  addIssue(emit, 7, { status: 'review' });
  emit({
    type: 'agentStarted',
    agentType: 'reviewer',
    issueNumber: 7,
    sessionID: 'sess-r-1',
  });
  emit({
    type: 'agentFailed',
    agentType: 'reviewer',
    issueNumber: 7,
    error: 'review crash',
    sessionID: 'sess-r-1',
  });
  store.getState().selectIssue(7);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#7');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Retry Reviewer for #7?');
  });

  stdin.write('y');

  await vi.waitFor(() => {
    expect(sentCommands).toContainEqual({ command: 'dispatchReviewer', issueNumber: 7 });
  });
});

// ---------------------------------------------------------------------------
// Enter — open in browser actions
// ---------------------------------------------------------------------------

test('it opens the PR in the browser when Enter is pressed on a review issue without a running agent', async () => {
  const { lastFrame, emit, store, stdin, onOpenURL } = setupTest();

  addIssue(emit, 4, { status: 'review' });
  const prDetails = new Map<number, CachedPRDetails>();
  prDetails.set(4, {
    number: 20,
    title: 'PR for #4',
    changedFilesCount: 5,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/20',
    stale: false,
  });
  store.setState({ prDetails });
  store.getState().selectIssue(4);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#4');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onOpenURL).toHaveBeenCalledWith('https://github.com/owner/repo/pull/20');
  });
});

test('it opens the issue in the browser when Enter is pressed on a needs-refinement issue', async () => {
  const { lastFrame, emit, store, stdin, onOpenURL } = setupTest();

  addIssue(emit, 6, { status: 'needs-refinement' });
  store.getState().selectIssue(6);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#6');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onOpenURL).toHaveBeenCalledWith('https://github.com/owner/repo/issues/6');
  });
});

test('it opens the issue in the browser when Enter is pressed on a blocked issue', async () => {
  const { lastFrame, emit, store, stdin, onOpenURL } = setupTest();

  addIssue(emit, 8, { status: 'blocked' });
  store.getState().selectIssue(8);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#8');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onOpenURL).toHaveBeenCalledWith('https://github.com/owner/repo/issues/8');
  });
});

test('it opens the PR in the browser when Enter is pressed on an approved issue', async () => {
  const { lastFrame, emit, store, stdin, onOpenURL } = setupTest();

  addIssue(emit, 9, { status: 'approved' });
  const prDetails = new Map<number, CachedPRDetails>();
  prDetails.set(9, {
    number: 30,
    title: 'PR for #9',
    changedFilesCount: 2,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/30',
    stale: false,
  });
  store.setState({ prDetails });
  store.getState().selectIssue(9);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#9');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onOpenURL).toHaveBeenCalledWith('https://github.com/owner/repo/pull/30');
  });
});

test('it falls back to the issue URL when no PR is found for a review issue', async () => {
  const { lastFrame, emit, store, stdin, onOpenURL, engine } = setupTest();

  vi.mocked(engine.getPRForIssue).mockResolvedValue(null);

  addIssue(emit, 4, { status: 'review' });
  store.getState().selectIssue(4);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#4');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onOpenURL).toHaveBeenCalledWith('https://github.com/owner/repo/issues/4');
  });
});

// ---------------------------------------------------------------------------
// Scrolling / visible window
// ---------------------------------------------------------------------------

test('it scrolls to keep the selected item visible when navigating past the visible area', async () => {
  const { lastFrame, emit, store, stdin } = setupTest({ height: 3 });

  for (let i = 1; i <= 5; i += 1) {
    addIssue(emit, i, {
      title: `Issue${i}`,
      createdAt: `2026-01-0${i}T00:00:00Z`,
    });
  }
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  // Navigate down one at a time, waiting for each to settle
  stdin.write('j');
  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#2');
  });

  stdin.write('j');
  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#3');
  });

  stdin.write('j');
  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    const selectedLine = lines.find((l) => l.includes('> '));
    expect(selectedLine).toContain('#4');
    // Issue 4 should be visible
    expect(frame).toContain('Issue4');
  });
});

// ---------------------------------------------------------------------------
// Prompt exclusivity — navigation ignored during prompt
// ---------------------------------------------------------------------------

test('it ignores navigation keys while a confirmation prompt is active', async () => {
  const { lastFrame, emit, store, stdin, onPromptChange } = setupTest();

  addIssue(emit, 1, { title: 'First' });
  addIssue(emit, 2, { title: 'Second', createdAt: '2026-01-02T00:00:00Z' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1');
  });

  // Trigger dispatch prompt
  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Dispatch Implementor for #1?');
  });

  // Try to navigate — should be ignored
  stdin.write('j');

  // Wait a tick
  await new Promise((r) => setTimeout(r, 50));

  // Dismiss and check selection didn't change
  stdin.write('n');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith(null);
  });

  expect(store.getState().selectedIssue).toBe(1);
});

// ---------------------------------------------------------------------------
// Focus — ignores input when not focused
// ---------------------------------------------------------------------------

test('it ignores input when the pane is not focused', async () => {
  const { emit, store, stdin } = setupTest({ focused: false });

  addIssue(emit, 1, { title: 'First' });
  addIssue(emit, 2, { title: 'Second', createdAt: '2026-01-02T00:00:00Z' });
  store.getState().selectIssue(1);

  stdin.write('j');

  // Give time for potential state change
  await new Promise((r) => setTimeout(r, 50));

  // Selection should not have changed
  expect(store.getState().selectedIssue).toBe(1);
});

// ---------------------------------------------------------------------------
// Cancel confirmation for reviewer running
// ---------------------------------------------------------------------------

test('it shows a cancel confirmation when Enter is pressed on a review issue with a running reviewer', async () => {
  const { lastFrame, emit, store, stdin, onPromptChange } = setupTest();

  addIssue(emit, 4, { status: 'review' });
  emit({
    type: 'agentStarted',
    agentType: 'reviewer',
    issueNumber: 4,
    sessionID: 'sess-r-1',
  });
  store.getState().selectIssue(4);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#4');
  });

  stdin.write('\r');

  await vi.waitFor(() => {
    expect(onPromptChange).toHaveBeenCalledWith('Cancel agent for #4?');
  });
});
