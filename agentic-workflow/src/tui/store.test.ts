import { expect, test, vi } from 'vitest';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStartedEvent,
  Engine,
  EngineCommand,
  EngineEvent,
  IssueRemovedEvent,
  IssueStatusChangedEvent,
  NotificationEvent,
} from '../types';
import { createEngineStore, selectRunningAgentCount } from './store';

type EventHandler = (event: EngineEvent) => void;

function createMockEngine() {
  const handlers: EventHandler[] = [];
  const sentCommands: EngineCommand[] = [];

  const engine: Engine = {
    start: vi.fn(() => Promise.resolve({ issueCount: 0, recoveriesPerformed: 0 })),
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

  return { engine, emit, sentCommands };
}

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
// issueStatusChanged
// ---------------------------------------------------------------------------

test('it upserts an issue in the issues map when issueStatusChanged is emitted', () => {
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

test('it does not clear lastFailure when issueStatusChanged has isRecovery true', () => {
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

test('it clears lastFailure when issueStatusChanged has isRecovery false', () => {
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

test('it clears lastFailure when issueStatusChanged has no isRecovery field', () => {
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

test('it marks issueDetails and prDetails as stale when issueStatusChanged fires', () => {
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

test('it adds a notification when issueStatusChanged is emitted', () => {
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
  expect(notifications[0]?.summary).toBe('Issue #3 status changed from pending to in-progress');
  expect(notifications[0]?.eventType).toBe('issueStatusChanged');
  expect(notifications[0]?.issueNumber).toBe(3);
});

// ---------------------------------------------------------------------------
// agentStarted
// ---------------------------------------------------------------------------

test('it sets agentRunning and agentType when agentStarted is emitted for an Implementor', () => {
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

test('it clears existing agentStreams buffer and subscribes to stream on agentStarted', () => {
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

test('it sets plannerRunning to true and skips stream subscription when Planner agentStarted is emitted', () => {
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
  expect(notifications[0]?.summary).toBe('Planner started for docs/specs/workflow.md');
});

// ---------------------------------------------------------------------------
// agentCompleted
// ---------------------------------------------------------------------------

test('it sets agentRunning to false and adds notification when Implementor agentCompleted is emitted', () => {
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
  const lastNotif = notifications[notifications.length - 1];
  expect(lastNotif?.summary).toBe('Implementor completed for issue #1');
});

test('it calls getPRForIssue to update notification contextURL when Implementor agentCompleted is emitted', async () => {
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
      (n) => n.eventType === 'agentCompleted' && n.issueNumber === 1,
    );
    expect(completedNotif?.contextURL).toBe('https://github.com/owner/repo/pull/10');
  });
});

test('it marks prDetails as stale when Reviewer agentCompleted is emitted', () => {
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

test('it sets plannerRunning to false when Planner agentCompleted is emitted', () => {
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

test('it records lastFailure with agentType, error, sessionID, and worktreePath for Implementor failure', () => {
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

test('it records lastFailure without worktreePath for Reviewer failure', () => {
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

test('it sets plannerRunning to false and does not record lastFailure for Planner failure', () => {
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

test('it removes issue and clears associated caches when issueRemoved is emitted', () => {
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

test('it does not reset selectedIssue when a different issue is removed', () => {
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

test('it adds notification with contextURL and calls getPRForIssue for approved status', async () => {
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
  expect(notifications[0]?.summary).toBe('Issue #5 approved — ready to merge');

  expect(engine.getPRForIssue).toHaveBeenCalledWith(5);

  await vi.waitFor(() => {
    const updated = store.getState().notifications[0];
    expect(updated?.contextURL).toBe('https://github.com/owner/repo/pull/10');
  });
});

test('it includes clipboardCommand in notification for needs-refinement status', () => {
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

  const notif = store.getState().notifications[0];
  expect(notif?.summary).toBe('Issue #3 needs spec refinement — Amend the spec');
  expect(notif?.clipboardCommand).toBe('claude -p "fix the spec"');
});

test('it creates notification with blocked summary for blocked status', () => {
  const { store, emit } = setupTest();

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 4,
    statusLabel: 'blocked',
    contextURL: 'https://github.com/owner/repo/issues/4',
    resolutionGuidance: 'Waiting on dependency',
  };
  emit(event);

  expect(store.getState().notifications[0]?.summary).toBe(
    'Issue #4 blocked — Waiting on dependency',
  );
});

// ---------------------------------------------------------------------------
// Other events
// ---------------------------------------------------------------------------

test('it adds notification for agentSkipped without changing issue state', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  emit({
    type: 'agentSkipped',
    agentType: 'implementor',
    issueNumber: 1,
  });

  const notifications = store.getState().notifications;
  const skipNotif = notifications.find((n) => n.eventType === 'agentSkipped');
  expect(skipNotif?.summary).toBe('Implementor skipped for issue #1 — already running');
});

test('it adds notification for dispatchReady without changing issue state', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  emit({
    type: 'dispatchReady',
    issueNumber: 1,
    statusLabel: 'status:pending',
  });

  const notifications = store.getState().notifications;
  const readyNotif = notifications.find((n) => n.eventType === 'dispatchReady');
  expect(readyNotif?.summary).toBe('Issue #1 ready for dispatch');
});

test('it adds notification for notificationDismissed', () => {
  const { store, emit } = setupTest();

  emit({ type: 'notificationDismissed', issueNumber: 3 });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.summary).toBe('Issue #3 notification dismissed');
});

test('it adds notification for recoveryPerformed', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'recoveryPerformed',
    issueNumber: 7,
    oldStatus: 'in-progress',
    newStatus: 'pending',
  });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.summary).toBe('Issue #7 recovered from stale in-progress');
});

test('it adds notification for specChanged with contextURL from commitSHA', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'specChanged',
    filePath: 'docs/specs/workflow.md',
    frontmatterStatus: 'approved',
    commitSHA: 'abc123def',
  });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);
  expect(notifications[0]?.summary).toBe('Spec changed: docs/specs/workflow.md');
  expect(notifications[0]?.contextURL).toBe('https://github.com/owner/repo/commit/abc123def');
});

// ---------------------------------------------------------------------------
// Stream buffer limit (ring buffer)
// ---------------------------------------------------------------------------

test('it drops the oldest chunk when the stream buffer exceeds 10,000 chunks', async () => {
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

test('it sends dispatchImplementor command and clears lastFailure when dispatchImplementor is called', () => {
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

test('it sends dispatchReviewer command and clears lastFailure when dispatchReviewer is called', () => {
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

test('it sends cancelAgent command when cancelAgent is called', () => {
  const { store, sentCommands } = setupTest();

  store.getState().cancelAgent(5);

  expect(sentCommands).toContainEqual({ command: 'cancelAgent', issueNumber: 5 });
});

test('it sends shutdown command and sets shuttingDown when shutdown is called', () => {
  const { store, sentCommands } = setupTest();

  store.getState().shutdown();

  expect(sentCommands).toContainEqual({ command: 'shutdown' });
  expect(store.getState().shuttingDown).toBe(true);
});

test('it cycles focus forward through panes', () => {
  const { store } = setupTest();

  expect(store.getState().focusedPane).toBe('issueList');

  store.getState().cycleFocus('forward');
  expect(store.getState().focusedPane).toBe('detailPane');

  store.getState().cycleFocus('forward');
  expect(store.getState().focusedPane).toBe('notifications');

  store.getState().cycleFocus('forward');
  expect(store.getState().focusedPane).toBe('issueList');
});

test('it cycles focus backward through panes', () => {
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

test('it fetches issue details on selectIssue when not cached', async () => {
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

test('it returns stale cached data immediately and re-fetches in the background', async () => {
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

test('it retains stale cached data when background re-fetch fails', async () => {
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

test('it computes runningAgentCount as count of running agents plus planner', () => {
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

test('it returns 0 for runningAgentCount when no agents are running', () => {
  const { store } = setupTest();

  expect(selectRunningAgentCount(store.getState())).toBe(0);
});

// ---------------------------------------------------------------------------
// Map immutability for Zustand change detection
// ---------------------------------------------------------------------------

test('it replaces the issues Map reference on every update', () => {
  const { store, emit } = setupTest();

  const initialMap = store.getState().issues;
  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  const updatedMap = store.getState().issues;

  expect(initialMap).not.toBe(updatedMap);
});

test('it replaces the agentStreams Map reference on agentStarted', () => {
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

test('it generates unique notification IDs and includes timestamps', () => {
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

test('it produces a notification for every engine event type', () => {
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
