import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import type { Engine, EngineEvent } from '../../types';
import { createEngineStore } from '../store';
import { DetailPane } from './detail-pane';

type EventHandler = (event: EngineEvent) => void;

function createMockEngine() {
  const handlers: EventHandler[] = [];

  const engine: Engine = {
    start: vi.fn(() => Promise.resolve({ issueCount: 0, recoveriesPerformed: 0 })),
    on(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    send() {},
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

  return { engine, emit };
}

function setupTest() {
  const { engine, emit } = createMockEngine();
  const store = createEngineStore({ engine, repository: 'owner/repo' });
  const instance = render(
    <Box flexDirection="column">
      <DetailPane store={store} />
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
        worktreePath: '/home/user/.worktrees/issue-1',
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
    expect(frame).toContain('/home/user/.worktrees/issue-1');
  });
});

test('it shows error details without a worktree path when a reviewer fails', async () => {
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
    expect(frame).not.toContain('Worktree:');
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
        worktreePath: '/tmp/wt',
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
