import { expect, test, vi } from 'vitest';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStartedEvent,
  IssueRemovedEvent,
  IssueStatusChangedEvent,
  NotificationEvent,
} from '../types';
import { createEngineStore, selectRunningAgentCount } from './store';
import { createMockEngine } from './test-utils/create-mock-engine';
import type {
  AgentCompletedNotification,
  AgentStartedNotification,
  EngineEventNotification,
  IssueStatusChangedNotification,
  SpecChangedNotification,
} from './types';

function setupTest() {
  const { engine, emit, sentCommands } = createMockEngine();
  const store = createEngineStore({ engine, repository: 'owner/repo' });
  return { store, engine, emit, sentCommands };
}

function buildIssueStatusChanged(
  overrides?: Partial<IssueStatusChangedEvent>,
): IssueStatusChangedEvent {
  return {
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Test issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Repository parsing
// ---------------------------------------------------------------------------

test('it parses the repository string into owner and repo at initialization', () => {
  const { store } = setupTest();

  const repo = store.getState().repository;
  expect(repo.owner).toBe('owner');
  expect(repo.repo).toBe('repo');
});

// ---------------------------------------------------------------------------
// issueStatusChanged
// ---------------------------------------------------------------------------

test('it tracks a new issue when an issue status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 5, title: 'My issue', newStatus: 'pending' }));

  const issue = store.getState().issues.get(5);
  expect(issue).toBeDefined();
  expect(issue?.number).toBe(5);
  expect(issue?.title).toBe('My issue');
  expect(issue?.statusLabel).toBe('pending');
  expect(issue?.priorityLabel).toBe('priority:medium');
  expect(issue?.createdAt).toBe('2026-01-01T00:00:00Z');
  expect(issue?.agentRunning).toBe(false);
});

test('it preserves the failure overlay when a status change is from crash recovery', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const failedEvent: AgentFailedEvent = {
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'timeout',
    sessionID: 'sess-1',
    worktreePath: '/tmp/wt',
  };
  emit(failedEvent);
  expect(store.getState().issues.get(1)?.lastFailure).toBeDefined();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending', isRecovery: true }));

  const issue = store.getState().issues.get(1);
  expect(issue?.lastFailure).toBeDefined();
  expect(issue?.lastFailure?.error).toBe('timeout');
});

test('it clears the failure overlay when a non-recovery status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const failedEvent: AgentFailedEvent = {
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'timeout',
    sessionID: 'sess-1',
    worktreePath: '/tmp/wt',
  };
  emit(failedEvent);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending', isRecovery: false }));

  expect(store.getState().issues.get(1)?.lastFailure).toBeUndefined();
});

test('it clears the failure overlay when a status change has no recovery flag', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const failedEvent: AgentFailedEvent = {
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'timeout',
    sessionID: 'sess-1',
  };
  emit(failedEvent);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  expect(store.getState().issues.get(1)?.lastFailure).toBeUndefined();
});

test('it marks cached issue and PR details as stale when an issue status changes', () => {
  const { store, emit } = setupTest();

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, { body: 'test', labels: [], stale: false });
  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'PR',
    changedFilesCount: 2,
    ciStatus: 'success',
    url: 'https://example.com',
    stale: false,
  });
  store.setState({ issueDetails, prDetails });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  expect(store.getState().issueDetails.get(1)?.stale).toBe(true);
  expect(store.getState().prDetails.get(1)?.stale).toBe(true);
});

test('it creates a typed notification with old and new status when an issue status changes', () => {
  const { store, emit } = setupTest();

  emit(
    buildIssueStatusChanged({
      issueNumber: 3,
      oldStatus: 'pending',
      newStatus: 'in-progress',
    }),
  );

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  const notif = notifications[0] as IssueStatusChangedNotification;
  expect(notif.eventType).toBe('issueStatusChanged');
  expect(notif.issueNumber).toBe(3);
  expect(notif.oldStatus).toBe('pending');
  expect(notif.newStatus).toBe('in-progress');
  expect(notif.summary).toBe('#3: pending → in-progress');
});

test('it renders the old status as none when an issue is first detected', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, oldStatus: null, newStatus: 'pending' }));

  const notif = store.getState().notifications[0] as IssueStatusChangedNotification;
  expect(notif.oldStatus).toBeNull();
  expect(notif.summary).toBe('#1: none → pending');
});

// ---------------------------------------------------------------------------
// agentStarted
// ---------------------------------------------------------------------------

test('it flags the issue as having a running agent when an implementor starts', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const event: AgentStartedEvent = {
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  };
  emit(event);

  const issue = store.getState().issues.get(1);
  expect(issue?.agentRunning).toBe(true);
  expect(issue?.agentType).toBe('implementor');
});

test('it resets the stream buffer and subscribes to a new stream when an agent starts', () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['old-chunk-1', 'old-chunk-2']);
  store.setState({ agentStreams });

  const event: AgentStartedEvent = {
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  };
  emit(event);

  expect(store.getState().agentStreams.get(1)).toEqual([]);
  expect(engine.getAgentStream).toHaveBeenCalledWith(1);
});

test('it flags the planner as running and derives the spec count when the planner starts', () => {
  const { store, emit, engine } = setupTest();

  const event: AgentStartedEvent = {
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/workflow.md'],
    sessionID: 'sess-plan-1',
  };
  emit(event);

  expect(store.getState().plannerRunning).toBe(true);
  expect(engine.getAgentStream).not.toHaveBeenCalled();

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  const notif = notifications[0] as AgentStartedNotification;
  expect(notif.eventType).toBe('agentStarted');
  expect(notif.agentType).toBe('planner');
  expect(notif.specCount).toBe(1);
  expect(notif.summary).toBe('Planner started for 1 specs');
});

test('it derives the correct spec count from multiple spec paths when the planner starts', () => {
  const { store, emit } = setupTest();

  const event: AgentStartedEvent = {
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/a.md', 'docs/specs/b.md', 'docs/specs/c.md'],
    sessionID: 'sess-plan-2',
  };
  emit(event);

  const notif = store.getState().notifications[0] as AgentStartedNotification;
  expect(notif.specCount).toBe(3);
  expect(notif.summary).toBe('Planner started for 3 specs');
});

// ---------------------------------------------------------------------------
// agentCompleted
// ---------------------------------------------------------------------------

test('it flags the agent as stopped and notifies when an implementor completes', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentCompleted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentCompletedEvent);

  expect(store.getState().issues.get(1)?.agentRunning).toBe(false);

  const notifications = store.getState().notifications;
  const lastNotif = notifications[notifications.length - 1] as AgentCompletedNotification;
  expect(lastNotif.summary).toBe('Implementor completed for #1');
  expect(lastNotif.agentType).toBe('implementor');
  expect(lastNotif.issueNumber).toBe(1);
});

test('it resolves the PR link on the notification when an implementor completes', async () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentCompleted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentCompletedEvent);

  expect(engine.getPRForIssue).toHaveBeenCalledWith(1);

  await vi.waitFor(() => {
    const notifications = store.getState().notifications;
    const completedNotif = notifications.find(
      (n) => n.eventType === 'agentCompleted' && 'issueNumber' in n && n.issueNumber === 1,
    );
    expect(completedNotif?.contextURL).toBe('https://github.com/owner/repo/pull/10');
  });
});

test('it marks cached PR details as stale when a reviewer completes', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'PR',
    changedFilesCount: 2,
    ciStatus: 'pending',
    url: 'https://example.com',
    stale: false,
  });
  store.setState({ prDetails });

  emit({
    type: 'agentStarted',
    agentType: 'reviewer',
    issueNumber: 1,
    sessionID: 'sess-r-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentCompleted',
    agentType: 'reviewer',
    issueNumber: 1,
    sessionID: 'sess-r-1',
  } satisfies AgentCompletedEvent);

  expect(store.getState().prDetails.get(1)?.stale).toBe(true);
});

test('it flags the planner as not running when the planner completes', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().plannerRunning).toBe(true);

  emit({
    type: 'agentCompleted',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentCompletedEvent);

  expect(store.getState().plannerRunning).toBe(false);
});

// ---------------------------------------------------------------------------
// agentFailed
// ---------------------------------------------------------------------------

test('it records a failure with worktree path when an implementor fails', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'process crashed',
    sessionID: 'sess-1',
    worktreePath: '/home/user/.worktrees/issue-1',
  } satisfies AgentFailedEvent);

  const issue = store.getState().issues.get(1);
  expect(issue?.agentRunning).toBe(false);
  expect(issue?.lastFailure).toEqual({
    agentType: 'implementor',
    error: 'process crashed',
    sessionID: 'sess-1',
    worktreePath: '/home/user/.worktrees/issue-1',
  });
});

test('it records a failure without worktree path when a reviewer fails', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));
  emit({
    type: 'agentStarted',
    agentType: 'reviewer',
    issueNumber: 1,
    sessionID: 'sess-r-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentFailed',
    agentType: 'reviewer',
    issueNumber: 1,
    error: 'review failed',
    sessionID: 'sess-r-1',
  } satisfies AgentFailedEvent);

  const issue = store.getState().issues.get(1);
  expect(issue?.lastFailure).toEqual({
    agentType: 'reviewer',
    error: 'review failed',
    sessionID: 'sess-r-1',
  });
});

test('it flags the planner as not running and skips failure recording when the planner fails', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentFailed',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    error: 'planner error',
    sessionID: 'sess-p-1',
  } satisfies AgentFailedEvent);

  expect(store.getState().plannerRunning).toBe(false);

  const notifications = store.getState().notifications;
  const failNotif = notifications.find((n) => n.eventType === 'agentFailed');
  expect(failNotif?.summary).toBe('Planner failed — planner error');
});

// ---------------------------------------------------------------------------
// issueRemoved
// ---------------------------------------------------------------------------

test('it removes the issue and clears all associated caches when an issue is dropped', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, ['chunk1']);
  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, { body: 'test', labels: [], stale: false });
  const prDetails = new Map(store.getState().prDetails);
  prDetails.set(1, {
    number: 10,
    title: 'PR',
    changedFilesCount: 1,
    ciStatus: 'success',
    url: 'https://example.com',
    stale: false,
  });
  store.setState({ agentStreams, issueDetails, prDetails, selectedIssue: 1 });

  emit({ type: 'issueRemoved', issueNumber: 1 } satisfies IssueRemovedEvent);

  expect(store.getState().issues.has(1)).toBe(false);
  expect(store.getState().agentStreams.has(1)).toBe(false);
  expect(store.getState().issueDetails.has(1)).toBe(false);
  expect(store.getState().prDetails.has(1)).toBe(false);
  expect(store.getState().selectedIssue).toBeNull();
});

test('it keeps the selected issue when a different issue is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'pending' }));
  store.setState({ selectedIssue: 1 });

  emit({ type: 'issueRemoved', issueNumber: 2 } satisfies IssueRemovedEvent);

  expect(store.getState().selectedIssue).toBe(1);
});

// ---------------------------------------------------------------------------
// notification (engine event)
// ---------------------------------------------------------------------------

test('it notifies with a PR link when an issue is approved', async () => {
  const { store, emit, engine } = setupTest();

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 5,
    statusLabel: 'approved',
    contextURL: 'https://github.com/owner/repo/issues/5',
  };
  emit(event);

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  const notif = notifications[0] as EngineEventNotification;
  expect(notif.summary).toBe('#5 approved — ready to merge');
  expect(notif.notificationType).toBe('approved');
  expect(notif.issueNumber).toBe(5);

  expect(engine.getPRForIssue).toHaveBeenCalledWith(5);

  await vi.waitFor(() => {
    const updated = store.getState().notifications[0];
    expect(updated?.contextURL).toBe('https://github.com/owner/repo/pull/10');
  });
});

test('it includes a clipboard command in the notification when an issue needs refinement', () => {
  const { store, emit } = setupTest();

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 3,
    statusLabel: 'needs-refinement',
    clipboardCommand: 'claude -p "fix the spec"',
    contextURL: 'https://github.com/owner/repo/issues/3',
    resolutionGuidance: 'Amend the spec',
  };
  emit(event);

  const notif = store.getState().notifications[0] as EngineEventNotification;
  expect(notif.summary).toBe('#3 needs refinement — Amend the spec');
  expect(notif.notificationType).toBe('needs-refinement');
  expect(notif.resolutionGuidance).toBe('Amend the spec');
  expect(notif.clipboardCommand).toBe('claude -p "fix the spec"');
});

test('it notifies with guidance text when an issue is blocked', () => {
  const { store, emit } = setupTest();

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 4,
    statusLabel: 'blocked',
    contextURL: 'https://github.com/owner/repo/issues/4',
    resolutionGuidance: 'Waiting on dependency',
  };
  emit(event);

  const notif = store.getState().notifications[0] as EngineEventNotification;
  expect(notif.summary).toBe('#4 blocked — Waiting on dependency');
  expect(notif.notificationType).toBe('blocked');
});

// ---------------------------------------------------------------------------
// Other events
// ---------------------------------------------------------------------------

test('it notifies without altering the issue when an agent dispatch is skipped', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  emit({
    type: 'agentSkipped',
    agentType: 'implementor',
    issueNumber: 1,
  });

  const notifications = store.getState().notifications;
  const skipNotif = notifications.find((n) => n.eventType === 'agentSkipped');
  expect(skipNotif?.summary).toBe('Implementor skipped for #1');
});

test('it notifies without altering the issue when an issue becomes ready for dispatch', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  emit({
    type: 'dispatchReady',
    issueNumber: 1,
    statusLabel: 'status:pending',
  });

  const notifications = store.getState().notifications;
  const readyNotif = notifications.find((n) => n.eventType === 'dispatchReady');
  expect(readyNotif?.summary).toBe('#1 ready for dispatch');
});

test('it records a notification when a prior notification is dismissed', () => {
  const { store, emit } = setupTest();

  emit({ type: 'notificationDismissed', issueNumber: 3 });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.summary).toBe('#3 dismissed');
});

test('it notifies when an issue is recovered from a stale status', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'recoveryPerformed',
    issueNumber: 7,
    oldStatus: 'in-progress',
    newStatus: 'pending',
  });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.summary).toBe('#7 recovered from stale');
});

test('it notifies with filename only and a commit link when a spec file changes', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'specChanged',
    filePath: 'docs/specs/workflow.md',
    frontmatterStatus: 'approved',
    commitSHA: 'abc123def',
  });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  const notif = notifications[0] as SpecChangedNotification;
  expect(notif.eventType).toBe('specChanged');
  expect(notif.specFileName).toBe('workflow.md');
  expect(notif.summary).toBe('Spec changed: workflow.md');
  expect(notif.contextURL).toBe('https://github.com/owner/repo/commit/abc123def');
});

// ---------------------------------------------------------------------------
// Stream buffer limit (ring buffer)
// ---------------------------------------------------------------------------

test('it drops the oldest output when the stream buffer is full', async () => {
  const { store, emit, engine } = setupTest();

  const chunks: string[] = [];
  for (let i = 0; i < 10_001; i++) {
    chunks.push(`chunk-${i}`);
  }

  let resolveStream: () => void;
  const streamPromise = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });

  async function* generateChunks(): AsyncGenerator<string> {
    for (const chunk of chunks) {
      yield chunk;
    }
    resolveStream();
  }

  vi.mocked(engine.getAgentStream).mockReturnValue(generateChunks());

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  await streamPromise;

  // Allow microtasks to flush
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get(1);
  expect(buffer).toBeDefined();
  expect(buffer?.length).toBe(10_000);
  expect(buffer?.[0]).toBe('chunk-1');
  expect(buffer?.[buffer.length - 1]).toBe('chunk-10000');
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

test('it dispatches an implementor and clears the failure overlay for that issue', () => {
  const { store, emit, sentCommands } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'fail',
    sessionID: 'sess-1',
  } satisfies AgentFailedEvent);

  expect(store.getState().issues.get(1)?.lastFailure).toBeDefined();

  store.getState().dispatchImplementor(1);

  expect(sentCommands).toContainEqual({ command: 'dispatchImplementor', issueNumber: 1 });
  expect(store.getState().issues.get(1)?.lastFailure).toBeUndefined();
});

test('it dispatches a reviewer and clears the failure overlay for that issue', () => {
  const { store, emit, sentCommands } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));
  emit({
    type: 'agentFailed',
    agentType: 'reviewer',
    issueNumber: 1,
    error: 'fail',
    sessionID: 'sess-r-1',
  } satisfies AgentFailedEvent);

  store.getState().dispatchReviewer(1);

  expect(sentCommands).toContainEqual({ command: 'dispatchReviewer', issueNumber: 1 });
  expect(store.getState().issues.get(1)?.lastFailure).toBeUndefined();
});

test('it sends a cancel command to the engine when cancelling an agent', () => {
  const { store, sentCommands } = setupTest();

  store.getState().cancelAgent(5);

  expect(sentCommands).toContainEqual({ command: 'cancelAgent', issueNumber: 5 });
});

test('it enters shutdown mode and tells the engine to shut down', () => {
  const { store, sentCommands } = setupTest();

  store.getState().shutdown();

  expect(sentCommands).toContainEqual({ command: 'shutdown' });
  expect(store.getState().shuttingDown).toBe(true);
});

test('it advances focus to the next pane when cycling forward', () => {
  const { store } = setupTest();

  expect(store.getState().focusedPane).toBe('issueList');

  store.getState().cycleFocus('forward');
  expect(store.getState().focusedPane).toBe('detailPane');

  store.getState().cycleFocus('forward');
  expect(store.getState().focusedPane).toBe('notifications');

  store.getState().cycleFocus('forward');
  expect(store.getState().focusedPane).toBe('issueList');
});

test('it moves focus to the previous pane when cycling backward', () => {
  const { store } = setupTest();

  expect(store.getState().focusedPane).toBe('issueList');

  store.getState().cycleFocus('backward');
  expect(store.getState().focusedPane).toBe('notifications');

  store.getState().cycleFocus('backward');
  expect(store.getState().focusedPane).toBe('detailPane');

  store.getState().cycleFocus('backward');
  expect(store.getState().focusedPane).toBe('issueList');
});

// ---------------------------------------------------------------------------
// selectIssue and stale-while-revalidate caching
// ---------------------------------------------------------------------------

test('it fetches issue details from the engine when selecting an uncached issue', async () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  store.getState().selectIssue(1);

  expect(engine.getIssueDetails).toHaveBeenCalledWith(1);

  await vi.waitFor(() => {
    const details = store.getState().issueDetails.get(1);
    expect(details).toBeDefined();
    expect(details?.body).toBe('body');
    expect(details?.stale).toBe(false);
  });
});

test('it returns stale data immediately while refreshing in the background', async () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, { body: 'old body', labels: ['old'], stale: true });
  store.setState({ issueDetails });

  vi.mocked(engine.getIssueDetails).mockResolvedValue({
    number: 1,
    title: 'Test',
    body: 'new body',
    labels: ['task:implement'],
    createdAt: '2026-01-01T00:00:00Z',
  });

  store.getState().selectIssue(1);

  // Stale data still available immediately
  expect(store.getState().issueDetails.get(1)?.body).toBe('old body');

  await vi.waitFor(() => {
    const details = store.getState().issueDetails.get(1);
    expect(details?.body).toBe('new body');
    expect(details?.stale).toBe(false);
  });
});

test('it keeps the stale data when a background refresh fails', async () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  const issueDetails = new Map(store.getState().issueDetails);
  issueDetails.set(1, { body: 'stale body', labels: ['old'], stale: true });
  store.setState({ issueDetails });

  vi.mocked(engine.getIssueDetails).mockRejectedValue(new Error('network error'));

  store.getState().selectIssue(1);

  // Wait for the rejected promise to settle
  await new Promise((r) => setTimeout(r, 50));

  const details = store.getState().issueDetails.get(1);
  expect(details?.body).toBe('stale body');
  expect(details?.stale).toBe(true);
});

// ---------------------------------------------------------------------------
// runningAgentCount selector
// ---------------------------------------------------------------------------

test('it counts all running agents including the planner', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'in-progress' }));

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 2,
    sessionID: 'sess-2',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentStartedEvent);

  expect(selectRunningAgentCount(store.getState())).toBe(3);
});

test('it reports zero running agents when none have started', () => {
  const { store } = setupTest();

  expect(selectRunningAgentCount(store.getState())).toBe(0);
});

// ---------------------------------------------------------------------------
// Map immutability for Zustand change detection
// ---------------------------------------------------------------------------

test('it produces a new issues collection reference on every update', () => {
  const { store, emit } = setupTest();

  const initialMap = store.getState().issues;
  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  const updatedMap = store.getState().issues;

  expect(initialMap).not.toBe(updatedMap);
});

test('it produces a new stream buffer collection reference when an agent starts', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  const initialMap = store.getState().agentStreams;

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().agentStreams).not.toBe(initialMap);
});

// ---------------------------------------------------------------------------
// Notification fields
// ---------------------------------------------------------------------------

test('it assigns unique IDs and timestamps to each notification', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'pending' }));

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(2);
  expect(notifications[0]?.id).not.toBe(notifications[1]?.id);
  expect(notifications[0]?.timestamp).toBeDefined();
  expect(notifications[1]?.timestamp).toBeDefined();
});

// ---------------------------------------------------------------------------
// All engine events produce notifications
// ---------------------------------------------------------------------------

test('it produces a notification for every type of engine event', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);
  emit({
    type: 'agentCompleted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentCompletedEvent);
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'err',
    sessionID: 'sess-2',
  } satisfies AgentFailedEvent);
  emit({
    type: 'agentSkipped',
    agentType: 'implementor',
    issueNumber: 1,
  });
  emit({
    type: 'dispatchReady',
    issueNumber: 1,
    statusLabel: 'status:pending',
  });
  emit({
    type: 'notification',
    issueNumber: 1,
    statusLabel: 'approved',
    contextURL: 'https://example.com',
  } satisfies NotificationEvent);
  emit({ type: 'notificationDismissed', issueNumber: 1 });
  emit({ type: 'issueRemoved', issueNumber: 1 } satisfies IssueRemovedEvent);
  emit({
    type: 'recoveryPerformed',
    issueNumber: 2,
    oldStatus: 'in-progress',
    newStatus: 'pending',
  });
  emit({
    type: 'specChanged',
    filePath: 'docs/specs/test.md',
    frontmatterStatus: 'approved',
    commitSHA: 'sha123',
  });

  const notifications = store.getState().notifications;
  const eventTypes = notifications.map((n) => n.eventType);

  expect(eventTypes).toContain('issueStatusChanged');
  expect(eventTypes).toContain('agentStarted');
  expect(eventTypes).toContain('agentCompleted');
  expect(eventTypes).toContain('agentFailed');
  expect(eventTypes).toContain('agentSkipped');
  expect(eventTypes).toContain('dispatchReady');
  expect(eventTypes).toContain('notification');
  expect(eventTypes).toContain('notificationDismissed');
  expect(eventTypes).toContain('issueRemoved');
  expect(eventTypes).toContain('recoveryPerformed');
  expect(eventTypes).toContain('specChanged');
});
