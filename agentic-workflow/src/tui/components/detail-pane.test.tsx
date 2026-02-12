import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import { createEngineStore } from '../store.ts';
import { createMockEngine } from '../test-utils/create-mock-engine.ts';
import { DetailPane } from './detail-pane.tsx';

interface SetupTestOptions {
  paneWidth?: number;
  paneHeight?: number;
}

function setupTest(options?: SetupTestOptions): ReturnType<typeof render> & {
  store: ReturnType<typeof createEngineStore>;
  engine: ReturnType<typeof createMockEngine>['engine'];
  emit: ReturnType<typeof createMockEngine>['emit'];
} {
  const paneWidth = options?.paneWidth ?? 80;
  const paneHeight = options?.paneHeight ?? 20;
  const { engine, emit } = createMockEngine();
  const store = createEngineStore({ engine, repository: 'owner/repo' });
  const instance = render(
    <Box flexDirection="column">
      <DetailPane store={store} paneWidth={paneWidth} paneHeight={paneHeight} />
    </Box>,
  );
  return { store, engine, emit, ...instance };
}

// ---------------------------------------------------------------------------
// No issue selected
// ---------------------------------------------------------------------------

test('it shows a placeholder when no issue is selected', () => {
  const { lastFrame } = setupTest();

  expect(lastFrame()).toContain('No issue selected');
});

// ---------------------------------------------------------------------------
// Issue details (pending/unblocked/needs-changes)
// ---------------------------------------------------------------------------

test('it displays issue details when a dispatchable issue is selected', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Fix the login bug',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Objective: Fix the login flow\nScope: auth module',
    labels: ['task:implement', 'priority:medium'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Fix the login bug');
    expect(frame).toContain('Objective: Fix the login flow');
    expect(frame).toContain('Scope: auth module');
    expect(frame).toContain('task:implement, priority:medium');
  });
});

test('it shows a loading indicator when selected issue has no cached data', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Fix the login bug',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  store.setState({ selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Loading...');
    expect(frame).toContain('#1 Fix the login bug');
  });
});

test('it shows stale data immediately without a loading spinner flash', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Fix the login bug',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Stale content here',
    labels: ['task:implement'],
    stale: true,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Stale content here');
    expect(frame).toContain('Refreshing...');
    expect(frame).not.toContain('Loading...');
  });
});

// ---------------------------------------------------------------------------
// Streaming (agent running)
// ---------------------------------------------------------------------------

test('it streams live implementor output when an agent is running', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Implement feature',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, agentRunning: true, agentType: 'implementor' });
  }

  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['Building project...', 'Running tests...', 'All tests passed.']);

  store.setState({ issues, agentStreams, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Implementor output for #1');
    expect(frame).toContain('Building project...');
    expect(frame).toContain('Running tests...');
    expect(frame).toContain('All tests passed.');
  });
});

test('it streams live reviewer output when a reviewer is running', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review PR',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, agentRunning: true, agentType: 'reviewer' });
  }

  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['Reviewing changes...', 'Code looks good.']);

  store.setState({ issues, agentStreams, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Reviewer output for #1');
    expect(frame).toContain('Reviewing changes...');
    expect(frame).toContain('Code looks good.');
  });
});

test('it auto-scrolls to the latest output when new chunks arrive', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Implement feature',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, agentRunning: true, agentType: 'implementor' });
  }

  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['Line 1']);
  store.setState({ issues, agentStreams, selectedIssue: 1 });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line 1');
  });

  const updatedStreams = new Map(store.getState().agentStreams);
  updatedStreams.set(1, ['Line 1', 'Line 2', 'Line 3']);
  store.setState({ agentStreams: updatedStreams });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line 3');
  });
});

// ---------------------------------------------------------------------------
// PR Summary (review, no agent)
// ---------------------------------------------------------------------------

test('it displays a PR summary when a review issue has no running agent', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('PR #10: feat: add login');
    expect(frame).toContain('Changed files: 5');
    expect(frame).toContain('CI: success');
  });
});

// ---------------------------------------------------------------------------
// Needs-refinement / blocked (with guidance)
// ---------------------------------------------------------------------------

test('it displays issue details with a status marker for a blocked issue', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Blocked task',
    oldStatus: null,
    newStatus: 'blocked',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Waiting on external dependency',
    labels: ['task:implement', 'status:blocked'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Blocked');
    expect(frame).toContain('Waiting on external dependency');
  });
});

test('it displays issue details with a refinement marker for a needs-refinement issue', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Needs spec fix',
    oldStatus: null,
    newStatus: 'needs-refinement',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Spec has ambiguity in section 3',
    labels: ['task:implement', 'status:needs-refinement'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Needs Refinement');
    expect(frame).toContain('Spec has ambiguity in section 3');
  });
});

// ---------------------------------------------------------------------------
// Approved (PR ready to merge)
// ---------------------------------------------------------------------------

test('it displays the PR summary with a ready-to-merge indicator for approved issues', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Approved task',
    oldStatus: null,
    newStatus: 'approved',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: approved PR',
    changedFilesCount: 2,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Ready to Merge');
    expect(frame).toContain('PR #10: feat: approved PR');
    expect(frame).toContain('CI: success');
  });
});

// ---------------------------------------------------------------------------
// Failure overlay
// ---------------------------------------------------------------------------

test('it shows error details when an issue has a failure from an implementor', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Failed task',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'implementor',
        error: 'process crashed',
        sessionID: 'sess-abc-123',
        branchName: 'issue-1-1700000000',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent Failure');
    expect(frame).toContain('Implementor');
    expect(frame).toContain('process crashed');
    expect(frame).toContain('sess-abc-123');
    expect(frame).toContain('issue-1-1700000000');
  });
});

test('it shows error details with branch name when a reviewer fails', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Failed review',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'reviewer',
        error: 'review timeout',
        sessionID: 'sess-rev-456',
        branchName: 'issue-1-pr-branch',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent Failure');
    expect(frame).toContain('Reviewer');
    expect(frame).toContain('review timeout');
    expect(frame).toContain('sess-rev-456');
    expect(frame).toContain('Branch: issue-1-pr-branch');
  });
});

test('it shows the log file path when a failure includes session log information', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Failed task',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'implementor',
        error: 'process crashed',
        sessionID: 'sess-abc-123',
        branchName: 'issue-1-1700000000',
        logFilePath: '/logs/2026-02-08T10-00-00Z-implementor-1.log',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent Failure');
    expect(frame).toContain('/logs/2026-02-08T10-00-00Z-implementor-1.log');
  });
});

test('it renders the log file path as a clickable terminal hyperlink', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Failed task',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'implementor',
        error: 'process crashed',
        sessionID: 'sess-abc-123',
        logFilePath: '/logs/agent.log',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // OSC 8 hyperlink format: \x1b]8;;<url>\x07<text>\x1b]8;;\x07
    expect(frame).toContain('\x1b]8;;file:///logs/agent.log\x07/logs/agent.log\x1b]8;;\x07');
  });
});

test('it does not show a log file path when a failure has no session log information', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Failed task',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'implementor',
        error: 'process crashed',
        sessionID: 'sess-abc-123',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent Failure');
    expect(frame).not.toContain('Log:');
  });
});

test('it shows the failure overlay regardless of the issue status label', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Recovered task',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'implementor',
        error: 'crashed',
        sessionID: 'sess-777',
        branchName: 'issue-1-1700000000',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Agent Failure');
    expect(frame).not.toContain('No issue selected');
    expect(frame).not.toContain('Loading...');
  });
});

// ---------------------------------------------------------------------------
// Keyboard scrolling
// ---------------------------------------------------------------------------

test('it scrolls issue details when the detail pane is focused and the user presses navigation keys', async () => {
  const { store, emit, lastFrame, stdin } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Scrollable issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Line A\nLine B\nLine C\nLine D\nLine E',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({
    issueDetails,
    selectedIssue: 1,
    focusedPane: 'detailPane',
  });

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
  const { store, emit, lastFrame, stdin } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Scrollable issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Line A\nLine B\nLine C',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({
    issueDetails,
    selectedIssue: 1,
    focusedPane: 'issueList',
  });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line A');
  });

  stdin.write('j');

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Line A');
  });
});

// ---------------------------------------------------------------------------
// Unblocked and needs-changes status display
// ---------------------------------------------------------------------------

test('it displays issue details for an unblocked issue', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Unblocked task',
    oldStatus: null,
    newStatus: 'unblocked',
    priorityLabel: 'priority:high',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Ready to be worked on',
    labels: ['task:implement', 'status:unblocked'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Unblocked task');
    expect(frame).toContain('Ready to be worked on');
  });
});

test('it displays issue details for a needs-changes issue', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Needs changes task',
    oldStatus: null,
    newStatus: 'needs-changes',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Reviewer requested changes',
    labels: ['task:implement', 'status:needs-changes'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('#1 Needs changes task');
    expect(frame).toContain('Reviewer requested changes');
  });
});

// ---------------------------------------------------------------------------
// Scroll windowing — only visible rows rendered
// ---------------------------------------------------------------------------

test('it only renders the visible window of lines when content exceeds the pane height', async () => {
  // paneHeight=3 means only 3 lines visible at a time.
  // Issue details: header + labels + blank + body lines = at least 4 lines.
  const { store, emit, lastFrame } = setupTest({ paneHeight: 3 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Long issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Body line 1\nBody line 2\nBody line 3\nBody line 4\nBody line 5',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

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
  const { store, emit, lastFrame, stdin } = setupTest({ paneHeight: 3 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Long issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Body line 1\nBody line 2\nBody line 3',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({
    issueDetails,
    selectedIssue: 1,
    focusedPane: 'detailPane',
  });

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
  const { store, emit, lastFrame } = setupTest({ paneHeight: 3 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Streaming',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, agentRunning: true, agentType: 'implementor' });
  }

  // 5 chunks + 1 header = 6 total lines, paneHeight=3
  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5']);
  store.setState({ issues, agentStreams, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Auto-scroll pins to tail: last 3 lines = Chunk 3, Chunk 4, Chunk 5
    expect(frame).toContain('Chunk 5');
    // Header and early chunks should be scrolled out
    expect(frame).not.toContain('Implementor output');
    expect(frame).not.toContain('Chunk 1');
  });
});

test('it applies scroll windowing to the failure overlay', async () => {
  // paneHeight=3: only 3 lines visible out of ~7 failure lines
  const { store, emit, lastFrame } = setupTest({ paneHeight: 3 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Failed task',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      lastFailure: {
        agentType: 'implementor',
        error: 'process crashed',
        sessionID: 'sess-abc-123',
        branchName: 'issue-1-1700000000',
        logFilePath: '/logs/agent.log',
      },
    });
  }
  store.setState({ issues, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // With 3 visible rows, only first 3 of ~8 failure lines visible:
    // "Agent Failure", "Issue: #1 Failed task", "Agent: Implementor"
    expect(frame).toContain('Agent Failure');
    // Later lines should NOT be visible without scrolling
    expect(frame).not.toContain('Press Enter');
  });
});

test('it applies scroll windowing to the PR summary', async () => {
  // paneHeight=3: only 3 of 4-5 PR lines visible
  const { store, emit, lastFrame } = setupTest({ paneHeight: 3 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // 4 lines total: PR title, Issue ref, Changed files, CI status
    // Only first 3 visible
    expect(frame).toContain('PR #10: feat: add login');
    expect(frame).toContain('Issue: #1 Review task');
    expect(frame).toContain('Changed files: 5');
    expect(frame).not.toContain('CI: success');
  });
});

// ---------------------------------------------------------------------------
// Line truncation
// ---------------------------------------------------------------------------

test('it truncates lines that exceed the pane width with an ellipsis', async () => {
  const { store, emit, lastFrame } = setupTest({ paneWidth: 20, paneHeight: 10 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'A very long title that exceeds the pane width',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Short line\nThis is a very long body line that definitely exceeds the twenty character pane width',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    // Title "#1 A very long title that exceeds..." should be truncated with ellipsis
    expect(frame).toContain('\u2026');
    // The full long line should NOT appear
    expect(frame).not.toContain('twenty character pane width');
  });
});

test('it does not truncate lines that fit within the pane width', async () => {
  const { store, emit, lastFrame } = setupTest({ paneWidth: 80 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Short title',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Short body',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1 });

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
  const { store, emit, lastFrame, stdin } = setupTest({ paneHeight: 3 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Streaming',
    oldStatus: null,
    newStatus: 'in-progress',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, agentRunning: true, agentType: 'implementor' });
  }

  // 4 chunks + 1 header = 5 total lines
  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4']);
  store.setState({ issues, agentStreams, selectedIssue: 1, focusedPane: 'detailPane' });

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
  updatedStreams.set(1, ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5']);
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
  finalStreams.set(1, ['Chunk 1', 'Chunk 2', 'Chunk 3', 'Chunk 4', 'Chunk 5', 'Chunk 6']);
  store.setState({ agentStreams: finalStreams });

  await vi.waitFor(() => {
    expect(lastFrame()).toContain('Chunk 6');
  });
});

// ---------------------------------------------------------------------------
// Scroll bounds
// ---------------------------------------------------------------------------

test('it does not scroll above the first line', async () => {
  const { store, emit, lastFrame, stdin } = setupTest({ paneHeight: 5 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1, focusedPane: 'detailPane' });

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
  const { store, emit, lastFrame, stdin } = setupTest({ paneHeight: 5 });

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, {
    body: 'Line 1\nLine 2\nLine 3',
    labels: ['task:implement'],
    stale: false,
  });
  store.setState({ issueDetails, selectedIssue: 1, focusedPane: 'detailPane' });

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
// No PR found
// ---------------------------------------------------------------------------

test('it shows a no-PR message when a review issue has no linked PR', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const prNotFound = new Set(store.getState().prNotFound);
  prNotFound.add(1);
  store.setState({ prNotFound, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('No PR found');
    expect(frame).not.toContain('Loading...');
  });
});

test('it shows a no-PR message when an approved issue has no linked PR', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Approved task',
    oldStatus: null,
    newStatus: 'approved',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const prNotFound = new Set(store.getState().prNotFound);
  prNotFound.add(1);
  store.setState({ prNotFound, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('No PR found');
    expect(frame).not.toContain('Loading...');
  });
});

test('it shows a loading indicator instead of no-PR when the PR lookup has not completed yet', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  // selectedIssue set, but no prDetails and no prNotFound entry
  store.setState({ selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('Loading...');
    expect(frame).not.toContain('No PR found');
  });
});

// ---------------------------------------------------------------------------
// CI failure display
// ---------------------------------------------------------------------------

test('it displays CI failure details when a review issue has ciStatus failure and failed check names', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, ciStatus: 'failure' });
  }

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'failure',
    failedCheckNames: ['lint', 'typecheck', 'test'],
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ issues, prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('CI: FAILURE');
    expect(frame).toContain('  - lint');
    expect(frame).toContain('  - typecheck');
    expect(frame).toContain('  - test');
  });
});

test('it displays CI failure with resolution guidance when an approved issue has ciStatus failure', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Approved task',
    oldStatus: null,
    newStatus: 'approved',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, {
      ...issue,
      ciStatus: 'failure',
      resolutionGuidance: 'Fix the linting errors and push a new commit.',
    });
  }

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: approved PR',
    changedFilesCount: 2,
    ciStatus: 'failure',
    failedCheckNames: ['lint'],
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ issues, prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('CI: FAILURE');
    expect(frame).toContain('  - lint');
    expect(frame).toContain('Fix the linting errors and push a new commit.');
  });
});

test('it does not show CI failure details when ciStatus is failure but failedCheckNames are not yet cached', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, ciStatus: 'failure' });
  }

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'failure',
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ issues, prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('CI: failure');
    expect(frame).not.toContain('CI: FAILURE');
  });
});

test('it does not show CI failure details when ciStatus is not failure', async () => {
  const { store, emit, lastFrame } = setupTest();

  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ prDetails, selectedIssue: 1 });

  await vi.waitFor(() => {
    const frame = lastFrame();
    expect(frame).toContain('CI: success');
    expect(frame).not.toContain('CI: FAILURE');
  });
});

test('it fetches CI check names on demand when a CI failure event fires and check names are not cached', async () => {
  const getCIStatus = vi.fn(async () => ({
    overall: 'failure' as const,
    failedCheckRuns: [
      {
        name: 'lint',
        status: 'completed' as const,
        conclusion: 'failure' as const,
        detailsURL: '',
      },
      {
        name: 'test',
        status: 'completed' as const,
        conclusion: 'failure' as const,
        detailsURL: '',
      },
    ],
  }));
  const { engine: _engine, emit: _emit } = createMockEngine({ getCIStatus });
  const store = createEngineStore({ engine: _engine, repository: 'owner/repo' });

  // Create the issue via event
  _emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  // Set ciStatus failure on the issue and PR without failedCheckNames
  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, ciStatus: 'failure' });
  }
  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'failure',
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ issues, prDetails });

  // Trigger ciStatusChanged with failure
  _emit({
    type: 'ciStatusChanged',
    prNumber: 10,
    issueNumber: 1,
    oldCIStatus: null,
    newCIStatus: 'failure',
  });

  // Verify getCIStatus was called and the result stored
  await vi.waitFor(() => {
    expect(getCIStatus).toHaveBeenCalledWith(10);
    const pr = store.getState().prDetails.get(1);
    expect(pr?.failedCheckNames).toStrictEqual(['lint', 'test']);
  });
});

test('it clears cached failed check names when CI status recovers', async () => {
  const { store, emit } = setupTest();

  // Create issue with ciStatus failure
  emit({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Review task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  });

  // Set up issue with ciStatus failure and PR with cached failedCheckNames
  const issues = new Map(store.getState().issues);
  const issue = issues.get(1);
  if (issue) {
    issues.set(1, { ...issue, ciStatus: 'failure' });
  }
  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'feat: add login',
    changedFilesCount: 5,
    ciStatus: 'failure',
    failedCheckNames: ['lint', 'test'],
    url: 'https://github.com/owner/repo/pull/10',
    stale: false,
  });
  store.setState({ issues, prDetails });

  // Emit ciCheckRecovered to clear CI failure state
  emit({
    type: 'ciCheckRecovered',
    issueNumber: 1,
  });

  // Verify failedCheckNames is cleared from cached PR
  await vi.waitFor(() => {
    const pr = store.getState().prDetails.get(1);
    expect(pr).toBeDefined();
    expect(pr?.failedCheckNames).toBeUndefined();
  });
});
