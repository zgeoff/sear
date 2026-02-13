import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import { createTUIStore } from '../store.ts';
import { createMockEngine } from '../test-utils/create-mock-engine.ts';
import type { Task, TaskAgent } from '../types.ts';
import { DetailPane } from './detail-pane.tsx';

interface SetupTestOptions {
  paneWidth?: number;
  paneHeight?: number;
}

function setupTest(options?: SetupTestOptions): ReturnType<typeof render> & {
  store: ReturnType<typeof createTUIStore>;
  engine: ReturnType<typeof createMockEngine>['engine'];
  emit: ReturnType<typeof createMockEngine>['emit'];
} {
  const paneWidth = options?.paneWidth ?? 80;
  const paneHeight = options?.paneHeight ?? 20;
  const { engine, emit } = createMockEngine();
  const store = createTUIStore({ engine });
  const instance = render(
    <Box flexDirection="column">
      <DetailPane store={store} paneWidth={paneWidth} paneHeight={paneHeight} />
    </Box>,
  );
  return { store, engine, emit, ...instance };
}

function buildTask(overrides: Partial<Task> & { issueNumber: number }): Task {
  return {
    title: `Task #${overrides.issueNumber}`,
    status: 'ready-to-implement',
    statusLabel: 'pending',
    priority: null,
    agentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    prs: [],
    agent: null,
    ...overrides,
  };
}

function pinTask(store: ReturnType<typeof createTUIStore>, issueNumber: number): void {
  const state = store.getState();
  // Only set pinnedTask (not trigger fetch side-effects from the store action)
  store.setState({ pinnedTask: issueNumber, selectedIssue: state.selectedIssue ?? issueNumber });
}

// ---------------------------------------------------------------------------
// No task selected
// ---------------------------------------------------------------------------

test('it shows a placeholder when no task is pinned', () => {
  const { lastFrame } = setupTest();

  expect(lastFrame()).toContain('No task selected');
});

// ---------------------------------------------------------------------------
// Issue detail view (ready-to-implement, needs-refinement, blocked)
// ---------------------------------------------------------------------------

test('it displays issue details when a ready-to-implement task is pinned', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Fix the login bug',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Objective: Fix the login flow\nScope: auth module',
    labels: ['task:implement', 'priority:medium'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Fix the login bug');
    expect(frame).toContain('Objective: Fix the login flow');
    expect(frame).toContain('Scope: auth module');
    expect(frame).toContain('task:implement, priority:medium');
  });
});

test('it displays issue details for a needs-refinement task', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Needs spec fix',
      status: 'needs-refinement',
      statusLabel: 'needs-refinement',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Spec has ambiguity in section 3',
    labels: ['task:implement', 'status:needs-refinement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Needs spec fix');
    expect(frame).toContain('Spec has ambiguity in section 3');
  });
});

test('it displays issue details for a blocked task', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({ issueNumber: 1, title: 'Blocked task', status: 'blocked', statusLabel: 'blocked' }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Waiting on external dependency',
    labels: ['task:implement', 'status:blocked'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Blocked task');
    expect(frame).toContain('Waiting on external dependency');
  });
});

test('it shows a loading indicator when the pinned task has no cached issue data', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Fix the login bug',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Loading...');
    expect(frame).toContain('#1 Fix the login bug');
  });
});

test('it shows stale data immediately with a refreshing indicator', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Fix the login bug',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Stale content here',
    labels: ['task:implement'],
    stale: true,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Stale content here');
    expect(frame).toContain('Refreshing...');
    expect(frame).not.toContain('Loading...');
  });
});

// ---------------------------------------------------------------------------
// Agent stream view (agent-implementing, agent-reviewing)
// ---------------------------------------------------------------------------

test('it streams live implementor output when an agent is implementing', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Implement feature',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Building project...', 'Running tests...', 'All tests passed.']);

  store.setState({ tasks, agentStreams });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Implementor output for #1');
    expect(frame).toContain('Building project...');
    expect(frame).toContain('Running tests...');
    expect(frame).toContain('All tests passed.');
  });
});

test('it streams live reviewer output when a reviewer is running', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = { type: 'reviewer', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Review PR',
      status: 'agent-reviewing',
      statusLabel: 'review',
      agent,
    }),
  );

  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Reviewing changes...', 'Code looks good.']);

  store.setState({ tasks, agentStreams });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Reviewer output for #1');
    expect(frame).toContain('Reviewing changes...');
    expect(frame).toContain('Code looks good.');
  });
});

test('it auto-scrolls to the latest output when new chunks arrive', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Implement feature',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Line 1']);
  store.setState({ tasks, agentStreams });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line 1');
  });

  const updatedStreams = new Map(store.getState().agentStreams);
  updatedStreams.set('sess-1', ['Line 1', 'Line 2', 'Line 3']);
  store.setState({ agentStreams: updatedStreams });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line 3');
  });
});

test('it only displays the last lines when the stream buffer exceeds the cap', async () => {
  const { store, lastFrame } = setupTest({ paneHeight: 5 });

  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Big stream',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  // Simulate a buffer that has been capped at 10,000 lines (oldest dropped)
  const lines: string[] = [];
  for (let i = 1; i <= 10_000; i += 1) {
    lines.push(`line-${i}`);
  }

  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', lines);
  store.setState({ tasks, agentStreams });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Auto-scroll pins to tail — last visible lines should be the final buffer entries
    expect(frame).toContain('line-10000');
    // Header and early lines should not be visible
    expect(frame).not.toContain('Implementor output');
    expect(frame).not.toContain('line-9990');
  });
});

// ---------------------------------------------------------------------------
// PR summary view (ready-to-merge)
// ---------------------------------------------------------------------------

test('it displays a PR summary for a ready-to-merge task with cached PR data', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Approved task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [{ number: 10, url: 'https://github.com/owner/repo/pull/10', ciStatus: 'success' }],
    }),
  );

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, {
    title: 'feat: approved PR',
    changedFilesCount: 2,
    stale: false,
  });
  store.setState({ tasks, prDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('PR #10: feat: approved PR');
    expect(frame).toContain('Changed files: 2');
    expect(frame).toContain('CI: success');
  });
});

test('it shows loading for each PR that has no cached detail', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Approved task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [{ number: 10, url: 'https://github.com/owner/repo/pull/10', ciStatus: 'success' }],
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('PR #10: Loading...');
  });
});

test('it displays multiple PRs in the summary view', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Multi-PR task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [
        { number: 10, url: 'https://github.com/owner/repo/pull/10', ciStatus: 'success' },
        { number: 11, url: 'https://github.com/owner/repo/pull/11', ciStatus: 'failure' },
      ],
    }),
  );

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, {
    title: 'feat: first PR',
    changedFilesCount: 3,
    stale: false,
  });
  prDetailCache.set(11, {
    title: 'feat: second PR',
    changedFilesCount: 7,
    failedCheckNames: ['lint', 'typecheck'],
    stale: false,
  });
  store.setState({ tasks, prDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('PR #10: feat: first PR');
    expect(frame).toContain('PR #11: feat: second PR');
    expect(frame).toContain('Changed files: 7');
    expect(frame).toContain('  - lint');
    expect(frame).toContain('  - typecheck');
  });
});

test('it displays CI failure details with failed check names', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Approved task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [{ number: 10, url: 'https://github.com/owner/repo/pull/10', ciStatus: 'failure' }],
    }),
  );

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, {
    title: 'feat: add login',
    changedFilesCount: 5,
    failedCheckNames: ['lint', 'typecheck', 'test'],
    stale: false,
  });
  store.setState({ tasks, prDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('CI: failure');
    expect(frame).toContain('  - lint');
    expect(frame).toContain('  - typecheck');
    expect(frame).toContain('  - test');
  });
});

test('it shows no linked PRs message when the task has no PRs', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'No PRs task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [],
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('No linked PRs');
  });
});

// ---------------------------------------------------------------------------
// Crash detail view (agent-crashed)
// ---------------------------------------------------------------------------

test('it shows crash details for an implementor failure', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = {
    type: 'implementor',
    running: false,
    sessionID: 'sess-abc-123',
    branchName: 'issue-1-1700000000',
    crash: { error: 'process crashed' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Failed task',
      status: 'agent-crashed',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent: Implementor');
    expect(frame).toContain('process crashed');
    expect(frame).toContain('Session: sess-abc-123');
    expect(frame).toContain('Branch: issue-1-1700000000');
    expect(frame).toContain('Press [d] to retry');
  });
});

test('it shows crash details with branch name for a reviewer failure', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = {
    type: 'reviewer',
    running: false,
    sessionID: 'sess-rev-456',
    branchName: 'issue-1-pr-branch',
    crash: { error: 'review timeout' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Failed review',
      status: 'agent-crashed',
      statusLabel: 'review',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent: Reviewer');
    expect(frame).toContain('review timeout');
    expect(frame).toContain('Session: sess-rev-456');
    expect(frame).toContain('Branch: issue-1-pr-branch');
  });
});

test('it renders the error message in red using ANSI escape codes', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = {
    type: 'implementor',
    running: false,
    sessionID: 'sess-1',
    crash: { error: 'fatal error' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'agent-crashed',
      statusLabel: 'pending',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // The error line starts with ANSI red escape (\x1b[31m) before "Error:"
    expect(frame).toContain('\x1b[31mError: fatal error');
  });
});

test('it shows the log file path as an OSC 8 terminal hyperlink', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = {
    type: 'implementor',
    running: false,
    sessionID: 'sess-abc-123',
    logFilePath: '/logs/agent.log',
    crash: { error: 'process crashed' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Failed task',
      status: 'agent-crashed',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // OSC 8 hyperlink format: \x1b]8;;<url>\x07<text>\x1b]8;;\x07
    expect(frame).toContain('\x1b]8;;file:///logs/agent.log\x07/logs/agent.log\x1b]8;;\x07');
  });
});

test('it does not show a log file line when logFilePath is not present', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = {
    type: 'implementor',
    running: false,
    sessionID: 'sess-abc-123',
    crash: { error: 'process crashed' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Failed task',
      status: 'agent-crashed',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent: Implementor');
    expect(frame).not.toContain('Log:');
  });
});

test('it shows a fallback message when an agent-crashed task has no agent data', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Crashed task',
      status: 'agent-crashed',
      statusLabel: 'in-progress',
      agent: null,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Crash information unavailable');
    expect(frame).toContain('Press [d] to retry');
    expect(frame).not.toContain('Agent:');
  });
});

test('it does not show a branch line when branchName is not present', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = {
    type: 'implementor',
    running: false,
    sessionID: 'sess-abc-123',
    crash: { error: 'process crashed' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Failed task',
      status: 'agent-crashed',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent: Implementor');
    expect(frame).not.toContain('Branch:');
  });
});

// ---------------------------------------------------------------------------
// Status change auto-switch
// ---------------------------------------------------------------------------

test('it switches from stream view to issue detail view when status changes', async () => {
  const { store, lastFrame } = setupTest();

  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Building...']);

  store.setState({ tasks, agentStreams });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Implementor output for #1');
  });

  // Status changes to ready-to-merge
  const updatedTasks = new Map<number, Task>();
  updatedTasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [{ number: 10, url: 'https://github.com/owner/repo/pull/10', ciStatus: 'success' }],
      agent: { ...agent, running: false },
    }),
  );

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, {
    title: 'feat: PR',
    changedFilesCount: 2,
    stale: false,
  });
  store.setState({ tasks: updatedTasks, prDetailCache });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('PR #10: feat: PR');
    expect(frame).not.toContain('Implementor output');
  });
});

test('it resumes auto-scroll from the tail when status changes to a stream view', async () => {
  const { store, lastFrame, stdin } = setupTest({ paneHeight: 3 });

  // Start with issue detail view
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache, focusedPane: 'detailPane' });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1 Task');
  });

  // Scroll down so we're not at the top
  stdin.write('j');
  stdin.write('j');

  await vi.waitFor(() => {
    expect(lastFrame()).not.toContain('#1 Task');
  });

  // Status changes to agent-implementing — auto-scroll should resume from tail
  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const updatedTasks = new Map<number, Task>();
  updatedTasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  // 5 chunks + 1 header = 6 total lines, paneHeight=3 → tail should show last 3
  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5']);
  store.setState({ tasks: updatedTasks, agentStreams });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Auto-scroll pins to tail: last 3 lines visible (Chunk 3, 4, 5)
    expect(frame).toContain('Chunk 5');
    // Header and early chunks are scrolled out — proves prior offset was discarded
    expect(frame).not.toContain('Implementor output');
    expect(frame).not.toContain('Chunk 1');
  });

  // Verify auto-scroll is active by adding more chunks
  const moreStreams = new Map(store.getState().agentStreams);
  moreStreams.set('sess-1', [
    'Chunk 1',
    'Chunk 2',
    'Chunk 3',
    'Chunk 4',
    'Chunk 5',
    'Chunk 6',
    'Chunk 7',
  ]);
  store.setState({ agentStreams: moreStreams });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Chunk 7');
  });
});

test('it resets scroll position to top when the pinned task status changes to a non-stream view', async () => {
  const { store, lastFrame, stdin } = setupTest({ paneHeight: 3 });

  // Start with issue detail that has enough content to scroll
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache, focusedPane: 'detailPane' });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1 Task');
  });

  // Scroll down
  stdin.write('j');
  stdin.write('j');

  await vi.waitFor(() => {
    expect(lastFrame()).not.toContain('#1 Task');
  });

  // Change status — scroll should reset
  const updatedTasks = new Map<number, Task>();
  updatedTasks.set(
    1,
    buildTask({ issueNumber: 1, title: 'Task', status: 'blocked', statusLabel: 'blocked' }),
  );
  store.setState({ tasks: updatedTasks });

  await vi.waitFor(() => {
    // Scroll reset to top — header should be visible again
    expect(lastFrame()).toContain('#1 Task');
  });
});

// ---------------------------------------------------------------------------
// Keyboard scrolling
// ---------------------------------------------------------------------------

test('it scrolls issue details when the detail pane is focused and the user presses navigation keys', async () => {
  const { store, lastFrame, stdin } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Scrollable issue',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Line A\nLine B\nLine C\nLine D\nLine E',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({
    tasks,
    issueDetailCache,
    focusedPane: 'detailPane',
  });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line A');
  });

  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Line B');
  });
});

test('it does not scroll when the detail pane is not focused', async () => {
  const { store, lastFrame, stdin } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Scrollable issue',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Line A\nLine B\nLine C',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({
    tasks,
    issueDetailCache,
    focusedPane: 'taskList',
  });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line A');
  });

  stdin.write('j');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line A');
  });
});

// ---------------------------------------------------------------------------
// Scroll windowing — only visible rows rendered
// ---------------------------------------------------------------------------

test('it only renders the visible window of lines when content exceeds the pane height', async () => {
  const { store, lastFrame } = setupTest({ paneHeight: 3 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Long issue',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Body line 1\nBody line 2\nBody line 3\nBody line 4\nBody line 5',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // First 3 lines: "#1 Long issue", "Labels: task:implement", ""
    expect(frame).toContain('#1 Long issue');
    expect(frame).toContain('Labels: task:implement');
    // Body line 4 and 5 should NOT be visible (beyond the window)
    expect(frame).not.toContain('Body line 4');
    expect(frame).not.toContain('Body line 5');
  });
});

test('it renders content beyond the window after scrolling down', async () => {
  const { store, lastFrame, stdin } = setupTest({ paneHeight: 3 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Long issue',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Body line 1\nBody line 2\nBody line 3',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({
    tasks,
    issueDetailCache,
    focusedPane: 'detailPane',
  });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1 Long issue');
  });

  // Scroll down 3 times to reach body content
  stdin.write('j');
  stdin.write('j');
  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Body line 1');
  });
});

test('it applies scroll windowing to streaming output', async () => {
  // paneHeight=3: header line + 2 visible chunk lines
  const { store, lastFrame } = setupTest({ paneHeight: 3 });

  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Streaming',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  // 5 chunks + 1 header = 6 total lines, paneHeight=3
  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5']);
  store.setState({ tasks, agentStreams });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Auto-scroll pins to tail: last 3 lines = Chunk 3, Chunk 4, Chunk 5
    expect(frame).toContain('Chunk 5');
    // Header and early chunks should be scrolled out
    expect(frame).not.toContain('Implementor output');
    expect(frame).not.toContain('Chunk 1');
  });
});

test('it applies scroll windowing to the crash detail view', async () => {
  // paneHeight=3: only 3 lines visible out of ~6 crash detail lines
  const { store, lastFrame } = setupTest({ paneHeight: 3 });

  const agent: TaskAgent = {
    type: 'implementor',
    running: false,
    sessionID: 'sess-abc-123',
    branchName: 'issue-1-1700000000',
    logFilePath: '/logs/agent.log',
    crash: { error: 'process crashed' },
  };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Failed task',
      status: 'agent-crashed',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  store.setState({ tasks });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // With 3 visible rows, only first 3 of ~6 crash lines visible:
    // "Agent: Implementor", "Error: process crashed", "Session: sess-abc-123"
    expect(frame).toContain('Agent: Implementor');
    // Later lines should NOT be visible without scrolling
    expect(frame).not.toContain('Press [d]');
  });
});

test('it applies scroll windowing to the PR summary', async () => {
  // paneHeight=3: only 3 of 3+ PR lines visible
  const { store, lastFrame } = setupTest({ paneHeight: 3 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Approved task',
      status: 'ready-to-merge',
      statusLabel: 'approved',
      prs: [{ number: 10, url: 'https://github.com/owner/repo/pull/10', ciStatus: 'success' }],
    }),
  );

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, {
    title: 'feat: add login',
    changedFilesCount: 5,
    stale: false,
  });
  store.setState({ tasks, prDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // 3 lines total: PR title, Changed files, CI status
    // All 3 should be visible
    expect(frame).toContain('PR #10: feat: add login');
    expect(frame).toContain('Changed files: 5');
    expect(frame).toContain('CI: success');
  });
});

// ---------------------------------------------------------------------------
// Line truncation
// ---------------------------------------------------------------------------

test('it truncates lines that exceed the pane width with an ellipsis', async () => {
  const { store, lastFrame } = setupTest({ paneWidth: 20, paneHeight: 10 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'A very long title that exceeds the pane width',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Short line\nThis is a very long body line that definitely exceeds the twenty character pane width',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Title "#1 A very long title that exceeds..." should be truncated with ellipsis
    expect(frame).toContain('\u2026');
    // The full long line should NOT appear
    expect(frame).not.toContain('twenty character pane width');
  });
});

test('it does not truncate lines that fit within the pane width', async () => {
  const { store, lastFrame } = setupTest({ paneWidth: 80 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Short title',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Short body',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Short title');
    expect(frame).toContain('Short body');
    expect(frame).not.toContain('\u2026');
  });
});

// ---------------------------------------------------------------------------
// Auto-scroll resume condition
// ---------------------------------------------------------------------------

test('it resumes auto-scroll when the user scrolls back to the bottom of the stream', async () => {
  // paneHeight=3, so visible row count is 3
  const { store, lastFrame, stdin } = setupTest({ paneHeight: 3 });

  const agent: TaskAgent = { type: 'implementor', running: true, sessionID: 'sess-1' };
  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Streaming',
      status: 'agent-implementing',
      statusLabel: 'in-progress',
      agent,
    }),
  );

  // 4 chunks + 1 header = 5 total lines
  const agentStreams = new Map<string, string[]>();
  agentStreams.set('sess-1', ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4']);
  store.setState({ tasks, agentStreams, focusedPane: 'detailPane' });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Chunk 4');
  });

  // Scroll up to pause auto-scroll
  stdin.write('k');

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Chunk 3');
  });

  // Add new chunk — should NOT auto-scroll because we scrolled up
  const updatedStreams = new Map(store.getState().agentStreams);
  updatedStreams.set('sess-1', ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5']);
  store.setState({ agentStreams: updatedStreams });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Chunk 5 should not be visible — auto-scroll is paused
    expect(frame).not.toContain('Chunk 5');
  });

  // Scroll down to the bottom to resume auto-scroll
  stdin.write('j');
  stdin.write('j');

  // Add another chunk — should auto-scroll now
  const finalStreams = new Map(store.getState().agentStreams);
  finalStreams.set('sess-1', ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5', 'Chunk 6']);
  store.setState({ agentStreams: finalStreams });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Chunk 6');
  });
});

// ---------------------------------------------------------------------------
// Scroll bounds
// ---------------------------------------------------------------------------

test('it does not scroll above the first line', async () => {
  const { store, lastFrame, stdin } = setupTest({ paneHeight: 5 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Issue',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache, focusedPane: 'detailPane' });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1 Issue');
  });

  // Try scrolling up past the top
  stdin.write('k');
  stdin.write('k');
  stdin.write('k');

  await vi.waitFor(() => {
    // First line should still be visible
    expect(lastFrame()).toContain('#1 Issue');
  });
});

test('it does not scroll below the last line', async () => {
  const { store, lastFrame, stdin } = setupTest({ paneHeight: 5 });

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Issue',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Line 1\nLine 2\nLine 3',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache, focusedPane: 'detailPane' });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1 Issue');
  });

  // Total lines = 6 (header, labels, blank, line1, line2, line3). paneHeight=5.
  // Max scroll offset = 6 - 5 = 1. Scrolling down more should not go past that.
  stdin.write('j');
  stdin.write('j');
  stdin.write('j');
  stdin.write('j');
  stdin.write('j');

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Last line should be visible
    expect(frame).toContain('Line 3');
  });
});

// ---------------------------------------------------------------------------
// Pinned task removal
// ---------------------------------------------------------------------------

test('it shows the no-task placeholder when the pinned task is unpinned', async () => {
  const { store, lastFrame } = setupTest();

  const tasks = new Map<number, Task>();
  tasks.set(
    1,
    buildTask({
      issueNumber: 1,
      title: 'Task',
      status: 'ready-to-implement',
      statusLabel: 'pending',
    }),
  );

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, {
    body: 'Some content',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ tasks, issueDetailCache });
  pinTask(store, 1);

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('#1 Task');
  });

  store.setState({ pinnedTask: null });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('No task selected');
  });
});
