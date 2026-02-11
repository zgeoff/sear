import { expect, test, vi } from 'vitest';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStartedEvent,
  IssueRemovedEvent,
  IssueStatusChangedEvent,
  NotificationEvent,
} from '../types.ts';
import { createEngineStore, selectRunningAgentCount } from './store.ts';
import { createMockEngine } from './test-utils/create-mock-engine.ts';

function setupTest(): {
  store: ReturnType<typeof createEngineStore>;
  engine: ReturnType<typeof createMockEngine>['engine'];
  emit: ReturnType<typeof createMockEngine>['emit'];
  sentCommands: ReturnType<typeof createMockEngine>['sentCommands'];
} {
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

interface StreamController {
  stream: AsyncGenerator<string>;
  push: (value: string) => void;
}

function buildStreamController(): StreamController {
  const pending: Array<(value: string) => void> = [];
  const queued: string[] = [];

  async function* generate(): AsyncGenerator<string> {
    // biome-ignore lint/nursery/noUnnecessaryConditions: infinite generator loop is intentional
    while (true) {
      if (queued.length > 0) {
        const value = queued.shift();
        if (value !== undefined) {
          yield value;
        }
      } else {
        // biome-ignore lint/performance/noAwaitInLoops: generator must await each chunk sequentially
        yield await new Promise<string>((resolve) => {
          pending.push(resolve);
        });
      }
    }
  }

  function push(value: string): void {
    const waiter = pending.shift();
    if (waiter) {
      waiter(value);
    } else {
      queued.push(value);
    }
  }

  return { stream: generate(), push };
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
    branchName: 'issue-1-1700000000',
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
    branchName: 'issue-1-1700000000',
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

  expect(notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'issueStatusChanged',
      issueNumber: 3,
      oldStatus: 'pending',
      newStatus: 'in-progress',
      summary: '#3: pending → in-progress',
    }),
  );
});

test('it renders the old status as none when an issue is first detected', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, oldStatus: null, newStatus: 'pending' }));

  expect(store.getState().notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'issueStatusChanged',
      oldStatus: null,
      summary: '#1: none → pending',
    }),
  );
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

  expect(store.getState().agentStreams.get(1)).toStrictEqual([]);
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

  expect(notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'agentStarted',
      agentType: 'planner',
      specCount: 1,
      summary: 'Planner started for 1 specs',
    }),
  );
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

  expect(store.getState().notifications).toContainEqual(
    expect.objectContaining({
      specCount: 3,
      summary: 'Planner started for 3 specs',
    }),
  );
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
  expect(notifications[0]).toMatchObject({
    eventType: 'agentCompleted',
    summary: 'Implementor completed for #1',
    agentType: 'implementor',
    issueNumber: 1,
  });
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

test('it includes the log file path on the notification when an agent completes with session logging', () => {
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
    logFilePath: '/logs/2026-02-08T10-00-00Z-implementor-1.log',
  } satisfies AgentCompletedEvent);

  expect(store.getState().notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'agentCompleted',
      issueNumber: 1,
      logFilePath: '/logs/2026-02-08T10-00-00Z-implementor-1.log',
    }),
  );
});

test('it omits the log file path on the notification when an agent completes without session logging', () => {
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

  const notifications = store.getState().notifications;
  const completedNotif = notifications.find(
    (n) => n.eventType === 'agentCompleted' && 'issueNumber' in n && n.issueNumber === 1,
  );
  expect(completedNotif).toBeDefined();
  expect(completedNotif).not.toHaveProperty('logFilePath');
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

test('it derives the spec count and includes it in the summary when the planner completes', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/a.md', 'docs/specs/b.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentCompleted',
    agentType: 'planner',
    specPaths: ['docs/specs/a.md', 'docs/specs/b.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentCompletedEvent);

  const notifications = store.getState().notifications;
  const completedNotif = notifications.find((n) => n.eventType === 'agentCompleted');
  expect(completedNotif).toMatchObject({
    eventType: 'agentCompleted',
    agentType: 'planner',
    specCount: 2,
    summary: 'Planner completed for 2 specs',
  });
});

test('it does not include the spec count when a task agent completes', () => {
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

  const notifications = store.getState().notifications;
  const completedNotif = notifications.find((n) => n.eventType === 'agentCompleted');
  expect(completedNotif).toBeDefined();
  expect(completedNotif).not.toHaveProperty('specCount');
});

// ---------------------------------------------------------------------------
// agentFailed
// ---------------------------------------------------------------------------

test('it records a failure with branch name when an implementor fails', () => {
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
    branchName: 'issue-1-1700000000',
  } satisfies AgentFailedEvent);

  const issue = store.getState().issues.get(1);
  expect(issue?.agentRunning).toBe(false);
  expect(issue?.lastFailure).toStrictEqual({
    agentType: 'implementor',
    error: 'process crashed',
    sessionID: 'sess-1',
    branchName: 'issue-1-1700000000',
  });
});

test('it records a failure with branch name when a reviewer fails', () => {
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
    branchName: 'issue-1-pr-branch',
  } satisfies AgentFailedEvent);

  const issue = store.getState().issues.get(1);
  expect(issue?.lastFailure).toStrictEqual({
    agentType: 'reviewer',
    error: 'review failed',
    sessionID: 'sess-r-1',
    branchName: 'issue-1-pr-branch',
  });
});

test('it records the log file path in the failure when an agent fails with session logging', () => {
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
    error: 'timeout',
    sessionID: 'sess-1',
    branchName: 'issue-1-1700000000',
    logFilePath: '/logs/2026-02-08T10-00-00Z-implementor-1.log',
  } satisfies AgentFailedEvent);

  const issue = store.getState().issues.get(1);
  expect(issue?.lastFailure?.logFilePath).toBe('/logs/2026-02-08T10-00-00Z-implementor-1.log');
});

test('it includes the log file path on the notification when an agent fails with session logging', () => {
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
    error: 'timeout',
    sessionID: 'sess-1',
    logFilePath: '/logs/2026-02-08T10-00-00Z-implementor-1.log',
  } satisfies AgentFailedEvent);

  expect(store.getState().notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'agentFailed',
      logFilePath: '/logs/2026-02-08T10-00-00Z-implementor-1.log',
    }),
  );
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

  expect(notifications).toContainEqual(
    expect.objectContaining({
      summary: '#5 approved — ready to merge',
      notificationType: 'approved',
      issueNumber: 5,
    }),
  );

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

  expect(store.getState().notifications).toContainEqual(
    expect.objectContaining({
      summary: '#3 needs refinement — Amend the spec',
      notificationType: 'needs-refinement',
      resolutionGuidance: 'Amend the spec',
      clipboardCommand: 'claude -p "fix the spec"',
    }),
  );
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

  expect(store.getState().notifications).toContainEqual(
    expect.objectContaining({
      summary: '#4 blocked — Waiting on dependency',
      notificationType: 'blocked',
    }),
  );
});

// ---------------------------------------------------------------------------
// resolutionGuidance on TrackedIssue
// ---------------------------------------------------------------------------

test('it sets resolution guidance on the tracked issue when a notification event has guidance', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'needs-refinement' }));

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 3,
    statusLabel: 'needs-refinement',
    contextURL: 'https://github.com/owner/repo/issues/3',
    resolutionGuidance: 'Amend the spec to clarify constraints',
  };
  emit(event);

  const issue = store.getState().issues.get(3);
  expect(issue?.resolutionGuidance).toBe('Amend the spec to clarify constraints');
});

test('it clears resolution guidance on a non-recovery status change', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'needs-refinement' }));

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 3,
    statusLabel: 'needs-refinement',
    contextURL: 'https://github.com/owner/repo/issues/3',
    resolutionGuidance: 'Fix the spec',
  };
  emit(event);

  expect(store.getState().issues.get(3)?.resolutionGuidance).toBe('Fix the spec');

  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'pending', isRecovery: false }));

  expect(store.getState().issues.get(3)?.resolutionGuidance).toBeUndefined();
});

test('it preserves resolution guidance on a recovery status change', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'blocked' }));

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 3,
    statusLabel: 'blocked',
    contextURL: 'https://github.com/owner/repo/issues/3',
    resolutionGuidance: 'Waiting on dependency',
  };
  emit(event);

  expect(store.getState().issues.get(3)?.resolutionGuidance).toBe('Waiting on dependency');

  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'pending', isRecovery: true }));

  expect(store.getState().issues.get(3)?.resolutionGuidance).toBe('Waiting on dependency');
});

test('it preserves the failure overlay when a status change is from an engine transition', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const failedEvent: AgentFailedEvent = {
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'timeout',
    sessionID: 'sess-1',
    branchName: 'issue-1-1700000000',
  };
  emit(failedEvent);
  expect(store.getState().issues.get(1)?.lastFailure).toBeDefined();

  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      newStatus: 'review',
      isEngineTransition: true,
    }),
  );

  const issue = store.getState().issues.get(1);
  expect(issue?.lastFailure).toBeDefined();
  expect(issue?.lastFailure?.error).toBe('timeout');
});

test('it preserves resolution guidance when an engine transition status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'blocked' }));

  const event: NotificationEvent = {
    type: 'notification',
    issueNumber: 3,
    statusLabel: 'blocked',
    contextURL: 'https://github.com/owner/repo/issues/3',
    resolutionGuidance: 'Waiting on dependency',
  };
  emit(event);

  expect(store.getState().issues.get(3)?.resolutionGuidance).toBe('Waiting on dependency');

  emit(
    buildIssueStatusChanged({
      issueNumber: 3,
      newStatus: 'pending',
      isEngineTransition: true,
    }),
  );

  expect(store.getState().issues.get(3)?.resolutionGuidance).toBe('Waiting on dependency');
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
    changeType: 'added',
    commitSHA: 'abc123def',
  });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  expect(notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'specChanged',
      specFileName: 'workflow.md',
      summary: 'Spec changed: workflow.md',
      contextURL: 'https://github.com/owner/repo/commit/abc123def',
    }),
  );
});

// ---------------------------------------------------------------------------
// Stream buffer limit (ring buffer)
// ---------------------------------------------------------------------------

test('it drops the oldest output when the stream buffer is full', async () => {
  const { store, emit, engine } = setupTest();

  const chunks: string[] = [];
  for (let i = 0; i < 10_001; i += 1) {
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

test('it sets the shutting down flag before sending the shutdown command to the engine', () => {
  const { engine } = createMockEngine();
  const store = createEngineStore({ engine, repository: 'owner/repo' });

  vi.mocked(engine.send).mockImplementation(() => {
    expect(store.getState().shuttingDown).toBe(true);
  });

  store.getState().shutdown();

  expect(vi.mocked(engine.send)).toHaveBeenCalledWith({ command: 'shutdown' });
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
    changeType: 'added',
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

// ---------------------------------------------------------------------------
// Startup notification
// ---------------------------------------------------------------------------

test('it creates a startup notification with the correct issue count and recovery count', () => {
  const { store } = setupTest();

  store.getState().handleStartup({ issueCount: 5, recoveriesPerformed: 2 });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  expect(notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'startup',
      issueCount: 5,
      recoveriesPerformed: 2,
      summary: 'Startup complete: 5 issues tracked, 2 recoveries performed',
    }),
  );
});

test('it omits the recovery clause in the startup summary when no recoveries were performed', () => {
  const { store } = setupTest();

  store.getState().handleStartup({ issueCount: 3, recoveriesPerformed: 0 });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(1);

  expect(notifications).toContainEqual(
    expect.objectContaining({
      eventType: 'startup',
      issueCount: 3,
      recoveriesPerformed: 0,
      summary: 'Startup complete: 3 issues tracked',
    }),
  );
});

test('it prepends the startup notification before any existing notifications', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  store.getState().handleStartup({ issueCount: 1, recoveriesPerformed: 0 });

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(2);
  expect(notifications[0]).toMatchObject({ eventType: 'startup' });
  expect(notifications[1]).toMatchObject({ eventType: 'issueStatusChanged' });
});

// ---------------------------------------------------------------------------
// Notification prepend order
// ---------------------------------------------------------------------------

test('it places newer notifications before older ones', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'review' }));

  const notifications = store.getState().notifications;
  expect(notifications).toHaveLength(2);
  expect(notifications[0]).toMatchObject({ issueNumber: 2, newStatus: 'review' });
  expect(notifications[1]).toMatchObject({ issueNumber: 1, newStatus: 'pending' });
});

// ---------------------------------------------------------------------------
// Stream newline splitting
// ---------------------------------------------------------------------------

test('it splits a stream chunk with newlines into individual buffer lines', async () => {
  const { store, emit, engine } = setupTest();

  let resolveStream: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });

  async function* generate(): AsyncGenerator<string> {
    yield 'line1\nline2\nline3\n';
    resolveStream();
  }

  vi.mocked(engine.getAgentStream).mockReturnValue(generate());

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  await streamDone;
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get(1);
  expect(buffer).toStrictEqual(['line1', 'line2', 'line3']);
});

test('it appends a chunk without newlines as a single buffer line', async () => {
  const { store, emit, engine } = setupTest();

  let resolveStream: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });

  async function* generate(): AsyncGenerator<string> {
    yield 'partial output';
    resolveStream();
  }

  vi.mocked(engine.getAgentStream).mockReturnValue(generate());

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  await streamDone;
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get(1);
  expect(buffer).toStrictEqual(['partial output']);
});

test('it discards the trailing empty string when a chunk ends with a newline', async () => {
  const { store, emit, engine } = setupTest();

  let resolveStream: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });

  async function* generate(): AsyncGenerator<string> {
    yield 'hello\n';
    resolveStream();
  }

  vi.mocked(engine.getAgentStream).mockReturnValue(generate());

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  await streamDone;
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get(1);
  expect(buffer).toStrictEqual(['hello']);
});

test('it accumulates lines from multiple chunks in order', async () => {
  const { store, emit, engine } = setupTest();

  let resolveStream: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });

  async function* generate(): AsyncGenerator<string> {
    yield 'first\nsecond\n';
    yield 'third';
    yield 'fourth\n';
    resolveStream();
  }

  vi.mocked(engine.getAgentStream).mockReturnValue(generate());

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  await streamDone;
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get(1);
  expect(buffer).toStrictEqual(['first', 'second', 'third', 'fourth']);
});

// ---------------------------------------------------------------------------
// Ring buffer viewport offset tracking
// ---------------------------------------------------------------------------

test('it decrements the viewport offset when lines are dropped from a full buffer', async () => {
  const { store, emit, engine } = setupTest();

  const controller = buildStreamController();
  vi.mocked(engine.getAgentStream).mockReturnValue(controller.stream);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  // Wait for the generator to start and reach its first await
  await new Promise((r) => setTimeout(r, 0));

  // Pre-fill buffer with 10,000 lines and set a viewport offset
  const prefilledBuffer: string[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    prefilledBuffer.push(`line-${i}`);
  }
  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, prefilledBuffer);
  const streamViewportOffsets = new Map(store.getState().streamViewportOffsets);
  streamViewportOffsets.set(1, 50);
  store.setState({ agentStreams, streamViewportOffsets });

  // Yield one chunk to trigger the drop
  controller.push('new-line');
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get(1);
  expect(buffer).toHaveLength(10_000);
  expect(store.getState().streamViewportOffsets.get(1)).toBe(49);
});

test('it does not decrement the viewport offset below zero when lines are dropped', async () => {
  const { store, emit, engine } = setupTest();

  const controller = buildStreamController();
  vi.mocked(engine.getAgentStream).mockReturnValue(controller.stream);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  await new Promise((r) => setTimeout(r, 0));

  // Pre-fill buffer with 10,000 lines and set offset to 0
  const prefilledBuffer: string[] = [];
  for (let i = 0; i < 10_000; i += 1) {
    prefilledBuffer.push(`line-${i}`);
  }
  const agentStreams = new Map(store.getState().agentStreams);
  agentStreams.set(1, prefilledBuffer);
  const streamViewportOffsets = new Map(store.getState().streamViewportOffsets);
  streamViewportOffsets.set(1, 0);
  store.setState({ agentStreams, streamViewportOffsets });

  controller.push('overflow');
  await new Promise((r) => setTimeout(r, 0));

  // Offset 0 is not decremented — auto-scroll would resume
  expect(store.getState().streamViewportOffsets.get(1)).toBe(0);
});

test('it clears the viewport offset when a new agent starts for the same issue', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const streamViewportOffsets = new Map(store.getState().streamViewportOffsets);
  streamViewportOffsets.set(1, 42);
  store.setState({ streamViewportOffsets });

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-2',
  } satisfies AgentStartedEvent);

  expect(store.getState().streamViewportOffsets.has(1)).toBe(false);
});

test('it clears the viewport offset when an issue is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  const streamViewportOffsets = new Map(store.getState().streamViewportOffsets);
  streamViewportOffsets.set(1, 10);
  store.setState({ streamViewportOffsets });

  emit({ type: 'issueRemoved', issueNumber: 1 } satisfies IssueRemovedEvent);

  expect(store.getState().streamViewportOffsets.has(1)).toBe(false);
});

// ---------------------------------------------------------------------------
// PR not found tracking
// ---------------------------------------------------------------------------

test('it does not cache the result in PR details when the PR lookup returns null', async () => {
  const { store, emit, engine } = setupTest();

  vi.mocked(engine.getPRForIssue).mockResolvedValue(null);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  await store.getState().selectIssue(1);

  expect(store.getState().prDetails.has(1)).toBe(false);
});

test('it marks the issue as having no linked PR when the PR lookup returns null', async () => {
  const { store, emit, engine } = setupTest();

  vi.mocked(engine.getPRForIssue).mockResolvedValue(null);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  await store.getState().selectIssue(1);

  expect(store.getState().prNotFound.has(1)).toBe(true);
});

test('it re-fetches the PR when re-selecting an issue that previously had no linked PR', async () => {
  const { store, emit, engine } = setupTest();

  vi.mocked(engine.getPRForIssue).mockResolvedValue(null);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  await store.getState().selectIssue(1);

  expect(store.getState().prNotFound.has(1)).toBe(true);
  expect(engine.getPRForIssue).toHaveBeenCalledTimes(1);

  // Re-select the same issue — should re-fetch because nothing is cached
  await store.getState().selectIssue(1);

  expect(engine.getPRForIssue).toHaveBeenCalledTimes(2);
});

test('it clears the no-PR marker when a subsequent fetch returns a real PR', async () => {
  const { store, emit, engine } = setupTest();

  vi.mocked(engine.getPRForIssue).mockResolvedValue(null);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  await store.getState().selectIssue(1);

  expect(store.getState().prNotFound.has(1)).toBe(true);

  // Now mock a successful PR result
  vi.mocked(engine.getPRForIssue).mockResolvedValue({
    number: 10,
    title: 'PR Title',
    changedFilesCount: 3,
    ciStatus: 'success',
    url: 'https://github.com/owner/repo/pull/10',
    isDraft: false,
    headRefName: 'feature-branch',
  });

  await store.getState().selectIssue(1);

  expect(store.getState().prNotFound.has(1)).toBe(false);
  expect(store.getState().prDetails.has(1)).toBe(true);
});

test('it clears the no-PR marker when the issue is removed', async () => {
  const { store, emit, engine } = setupTest();

  vi.mocked(engine.getPRForIssue).mockResolvedValue(null);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  await store.getState().selectIssue(1);

  expect(store.getState().prNotFound.has(1)).toBe(true);

  emit({ type: 'issueRemoved', issueNumber: 1 } satisfies IssueRemovedEvent);

  expect(store.getState().prNotFound.has(1)).toBe(false);
});
