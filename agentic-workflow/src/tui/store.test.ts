import { expect, test, vi } from 'vitest';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStartedEvent,
  CIStatusChangedEvent,
  IssueStatusChangedEvent,
  PRLinkedEvent,
} from '../types.ts';
import {
  createTUIStore,
  deriveStatus,
  parsePriority,
  selectActionCount,
  selectAgentSectionCount,
  selectRunningAgentCount,
  selectSortedTasks,
} from './store.ts';
import { createMockEngine } from './test-utils/create-mock-engine.ts';

function setupTest(): {
  store: ReturnType<typeof createTUIStore>;
  engine: ReturnType<typeof createMockEngine>['engine'];
  emit: ReturnType<typeof createMockEngine>['emit'];
  sentCommands: ReturnType<typeof createMockEngine>['sentCommands'];
} {
  const { engine, emit, sentCommands } = createMockEngine();
  const store = createTUIStore({ engine });
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
// deriveStatus
// ---------------------------------------------------------------------------

test('it derives agent-crashed when a task has a crash set', () => {
  const result = deriveStatus({
    agent: {
      type: 'implementor',
      running: false,
      sessionID: 'sess-1',
      crash: { error: 'timeout' },
    },
    statusLabel: 'pending',
  });
  expect(result).toBe('agent-crashed');
});

test('it derives agent-implementing when a running implementor overrides the label', () => {
  const result = deriveStatus({
    agent: { type: 'implementor', running: true, sessionID: 'sess-1' },
    statusLabel: 'pending',
  });
  expect(result).toBe('agent-implementing');
});

test('it derives agent-reviewing when a running reviewer overrides the label', () => {
  const result = deriveStatus({
    agent: { type: 'reviewer', running: true, sessionID: 'sess-1' },
    statusLabel: 'review',
  });
  expect(result).toBe('agent-reviewing');
});

test('it derives ready-to-implement from the pending status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'pending' });
  expect(result).toBe('ready-to-implement');
});

test('it derives ready-to-implement from the unblocked status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'unblocked' });
  expect(result).toBe('ready-to-implement');
});

test('it derives ready-to-implement from the needs-changes status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'needs-changes' });
  expect(result).toBe('ready-to-implement');
});

test('it derives agent-implementing from the in-progress status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'in-progress' });
  expect(result).toBe('agent-implementing');
});

test('it derives agent-reviewing from the review status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'review' });
  expect(result).toBe('agent-reviewing');
});

test('it derives needs-refinement from the needs-refinement status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'needs-refinement' });
  expect(result).toBe('needs-refinement');
});

test('it derives blocked from the blocked status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'blocked' });
  expect(result).toBe('blocked');
});

test('it derives ready-to-merge from the approved status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'approved' });
  expect(result).toBe('ready-to-merge');
});

test('it returns null for an unrecognized status label', () => {
  const result = deriveStatus({ agent: null, statusLabel: 'unknown-future-status' });
  expect(result).toBeNull();
});

test('it prioritizes crash over running agent', () => {
  const result = deriveStatus({
    agent: {
      type: 'implementor',
      running: true,
      sessionID: 'sess-1',
      crash: { error: 'oops' },
    },
    statusLabel: 'in-progress',
  });
  expect(result).toBe('agent-crashed');
});

// ---------------------------------------------------------------------------
// parsePriority
// ---------------------------------------------------------------------------

test('it parses high priority from the label', () => {
  expect(parsePriority('priority:high')).toBe('high');
});

test('it parses medium priority from the label', () => {
  expect(parsePriority('priority:medium')).toBe('medium');
});

test('it parses low priority from the label', () => {
  expect(parsePriority('priority:low')).toBe('low');
});

test('it returns null for an unrecognized priority label', () => {
  expect(parsePriority('other')).toBeNull();
});

// ---------------------------------------------------------------------------
// Task Lifecycle — issueStatusChanged (create)
// ---------------------------------------------------------------------------

test('it creates a task with default fields when a new issue status is received', () => {
  const { store, emit } = setupTest();

  emit(
    buildIssueStatusChanged({
      issueNumber: 5,
      title: 'My issue',
      newStatus: 'pending',
      priorityLabel: 'priority:high',
    }),
  );

  const task = store.getState().tasks.get(5);
  expect(task).toBeDefined();
  expect(task).toMatchObject({
    issueNumber: 5,
    title: 'My issue',
    statusLabel: 'pending',
    status: 'ready-to-implement',
    priority: 'high',
    agentCount: 0,
    createdAt: '2026-01-01T00:00:00Z',
    prs: [],
    agent: null,
  });
});

test('it updates a task title and status label when a status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      title: 'Updated title',
      newStatus: 'in-progress',
    }),
  );

  const task = store.getState().tasks.get(1);
  expect(task?.title).toBe('Updated title');
  expect(task?.statusLabel).toBe('in-progress');
  expect(task?.status).toBe('agent-implementing');
});

// ---------------------------------------------------------------------------
// Task Lifecycle — issueStatusChanged (removal via newStatus: null)
// ---------------------------------------------------------------------------

test('it removes a task when a status change with null status is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  expect(store.getState().tasks.has(1)).toBe(true);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().tasks.has(1)).toBe(false);
});

test('it clears the issue detail cache when a task is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, { body: 'test', labels: [], stale: false });
  store.setState({ issueDetailCache });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().issueDetailCache.has(1)).toBe(false);
});

test('it clears the PR detail cache entries when a task with linked PRs is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  // Link a PR
  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: null,
  } satisfies PRLinkedEvent);

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, { title: 'PR', changedFilesCount: 2, stale: false });
  store.setState({ prDetailCache });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().prDetailCache.has(10)).toBe(false);
});

test('it clears the agent stream when a task with an active agent is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().agentStreams.has('sess-1')).toBe(true);

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().agentStreams.has('sess-1')).toBe(false);
});

test('it nulls the pinned task when the pinned task is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  store.setState({ pinnedTask: 1 });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().pinnedTask).toBeNull();
});

test('it preserves the pinned task when a different task is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'pending' }));
  store.setState({ pinnedTask: 1 });

  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: null }));
  expect(store.getState().pinnedTask).toBe(1);
});

test('it moves the selection to the next task in sort order when the selected task is removed', () => {
  const { store, emit } = setupTest();

  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      newStatus: 'pending',
      priorityLabel: 'priority:high',
    }),
  );
  emit(
    buildIssueStatusChanged({
      issueNumber: 2,
      newStatus: 'pending',
      priorityLabel: 'priority:medium',
    }),
  );
  store.setState({ selectedIssue: 1 });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().selectedIssue).toBe(2);
});

test('it sets the selection to null when the last task is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  store.setState({ selectedIssue: 1 });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: null }));
  expect(store.getState().selectedIssue).toBeNull();
});

test('it preserves the selection when a non-selected task is removed', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'pending' }));
  store.setState({ selectedIssue: 1 });

  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: null }));
  expect(store.getState().selectedIssue).toBe(1);
});

// ---------------------------------------------------------------------------
// Task Lifecycle — agent preservation on issueStatusChanged
// ---------------------------------------------------------------------------

test('it preserves agent state when a recovery status change is received', () => {
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
  } satisfies AgentFailedEvent);

  expect(store.getState().tasks.get(1)?.agent?.crash).toBeDefined();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending', isRecovery: true }));

  const task = store.getState().tasks.get(1);
  expect(task?.agent).toBeDefined();
  expect(task?.agent?.crash?.error).toBe('timeout');
  expect(task?.status).toBe('agent-crashed');
});

test('it preserves agent state when an engine transition status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().tasks.get(1)?.agent?.running).toBe(true);

  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      newStatus: 'review',
      isEngineTransition: true,
    }),
  );

  const task = store.getState().tasks.get(1);
  expect(task?.agent).toBeDefined();
  expect(task?.agent?.sessionID).toBe('sess-1');
});

test('it clears agent state when a human-initiated status change is received', () => {
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
  } satisfies AgentFailedEvent);

  expect(store.getState().tasks.get(1)?.agent?.crash).toBeDefined();

  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      newStatus: 'pending',
      isRecovery: false,
      isEngineTransition: false,
    }),
  );

  const task = store.getState().tasks.get(1);
  expect(task?.agent).toBeNull();
  expect(task?.status).toBe('ready-to-implement');
});

// ---------------------------------------------------------------------------
// Caching — issueDetailCache stale marking
// ---------------------------------------------------------------------------

test('it marks cached issue details as stale when an issue status changes', () => {
  const { store, emit } = setupTest();

  const issueDetailCache = new Map(store.getState().issueDetailCache);
  issueDetailCache.set(1, { body: 'test', labels: [], stale: false });
  store.setState({ issueDetailCache });

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  expect(store.getState().issueDetailCache.get(1)?.stale).toBe(true);
});

// ---------------------------------------------------------------------------
// Agent Lifecycle — agentStarted
// ---------------------------------------------------------------------------

test('it sets the planner to running and does not update any task when the planner starts', () => {
  const { store, emit, engine } = setupTest();

  emit({
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/workflow.md'],
    sessionID: 'sess-plan-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().plannerStatus).toBe('running');
  expect(store.getState().tasks.size).toBe(0);
  expect(engine.getAgentStream).not.toHaveBeenCalled();
});

test('it sets agent metadata and increments agent count when an implementor starts', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
    branchName: 'issue-1-1700000000',
    logFilePath: '/logs/agent.log',
  } satisfies AgentStartedEvent);

  const task = store.getState().tasks.get(1);
  expect(task?.agent).toMatchObject({
    type: 'implementor',
    running: true,
    sessionID: 'sess-1',
    branchName: 'issue-1-1700000000',
    logFilePath: '/logs/agent.log',
  });
  expect(task?.agentCount).toBe(1);
  expect(task?.status).toBe('agent-implementing');
});

test('it increments agent count on each subsequent agent start', () => {
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

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-2',
  } satisfies AgentStartedEvent);

  expect(store.getState().tasks.get(1)?.agentCount).toBe(2);
});

test('it subscribes to a stream by session ID when an agent starts', () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  expect(engine.getAgentStream).toHaveBeenCalledWith('sess-1');
  expect(store.getState().agentStreams.has('sess-1')).toBe(true);
  expect(store.getState().agentStreams.get('sess-1')).toStrictEqual([]);
});

test('it skips the agent start when no task exists for the issue number', () => {
  const { store, emit, engine } = setupTest();

  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 999,
    sessionID: 'sess-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().tasks.size).toBe(0);
  expect(engine.getAgentStream).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Agent Lifecycle — agentCompleted
// ---------------------------------------------------------------------------

test('it sets agent running to false when an agent completes', () => {
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

  const task = store.getState().tasks.get(1);
  expect(task?.agent?.running).toBe(false);
  expect(task?.agent?.sessionID).toBe('sess-1');
});

test('it finds the task by session ID when an agent completes', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-abc',
  } satisfies AgentStartedEvent);

  // agentCompleted uses sessionID for lookup
  emit({
    type: 'agentCompleted',
    agentType: 'implementor',
    sessionID: 'sess-abc',
  } satisfies AgentCompletedEvent);

  expect(store.getState().tasks.get(1)?.agent?.running).toBe(false);
});

test('it sets the planner to idle when the planner completes', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'agentStarted',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentStartedEvent);

  expect(store.getState().plannerStatus).toBe('running');

  emit({
    type: 'agentCompleted',
    agentType: 'planner',
    specPaths: ['docs/specs/test.md'],
    sessionID: 'sess-p-1',
  } satisfies AgentCompletedEvent);

  expect(store.getState().plannerStatus).toBe('idle');
});

// ---------------------------------------------------------------------------
// Agent Lifecycle — agentFailed
// ---------------------------------------------------------------------------

test('it sets agent crash data when an agent fails', () => {
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
  } satisfies AgentFailedEvent);

  const task = store.getState().tasks.get(1);
  expect(task?.agent?.running).toBe(false);
  expect(task?.agent?.crash).toStrictEqual({ error: 'process crashed' });
  expect(task?.status).toBe('agent-crashed');
});

test('it finds the task by session ID when an agent fails', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-xyz',
  } satisfies AgentStartedEvent);

  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    error: 'timeout',
    sessionID: 'sess-xyz',
  } satisfies AgentFailedEvent);

  expect(store.getState().tasks.get(1)?.agent?.crash?.error).toBe('timeout');
});

test('it sets the planner to idle when the planner fails', () => {
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
    error: 'planner error',
    sessionID: 'sess-p-1',
  } satisfies AgentFailedEvent);

  expect(store.getState().plannerStatus).toBe('idle');
});

// ---------------------------------------------------------------------------
// specChanged — no-op
// ---------------------------------------------------------------------------

test('it does not update any task or state when a spec change event is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  const tasksBefore = store.getState().tasks;

  emit({
    type: 'specChanged',
    filePath: 'docs/specs/workflow.md',
    frontmatterStatus: 'approved',
    changeType: 'added',
    commitSHA: 'abc123def',
  });

  expect(store.getState().tasks).toBe(tasksBefore);
});

// ---------------------------------------------------------------------------
// PR Tracking — prLinked
// ---------------------------------------------------------------------------

test('it appends a new PR to the task when a PR linked event is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: 'pending',
  } satisfies PRLinkedEvent);

  const task = store.getState().tasks.get(1);
  expect(task?.prs).toStrictEqual([
    { number: 10, url: 'https://example.com/pull/10', ciStatus: 'pending' },
  ]);
});

test('it updates an existing PR when a PR linked event has a matching number', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: null,
  } satisfies PRLinkedEvent);

  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: 'success',
  } satisfies PRLinkedEvent);

  const task = store.getState().tasks.get(1);
  expect(task?.prs).toHaveLength(1);
  expect(task?.prs[0]?.ciStatus).toBe('success');
});

test('it ignores a PR linked event when no task exists for the issue', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'prLinked',
    issueNumber: 999,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: null,
  } satisfies PRLinkedEvent);

  expect(store.getState().tasks.size).toBe(0);
});

test('it marks PR detail cache as stale when a PR linked event is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, { title: 'PR', changedFilesCount: 2, stale: false });
  store.setState({ prDetailCache });

  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: 'success',
  } satisfies PRLinkedEvent);

  expect(store.getState().prDetailCache.get(10)?.stale).toBe(true);
});

// ---------------------------------------------------------------------------
// PR Tracking — ciStatusChanged
// ---------------------------------------------------------------------------

test('it updates CI status on a matching PR when a CI status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));
  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://example.com/pull/10',
    ciStatus: 'pending',
  } satisfies PRLinkedEvent);

  emit({
    type: 'ciStatusChanged',
    prNumber: 10,
    issueNumber: 1,
    oldCIStatus: 'pending',
    newCIStatus: 'success',
  } satisfies CIStatusChangedEvent);

  expect(store.getState().tasks.get(1)?.prs[0]?.ciStatus).toBe('success');
});

test('it creates a partial PR entry when a CI status change has no matching PR', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  emit({
    type: 'ciStatusChanged',
    prNumber: 10,
    issueNumber: 1,
    oldCIStatus: null,
    newCIStatus: 'pending',
  } satisfies CIStatusChangedEvent);

  const task = store.getState().tasks.get(1);
  expect(task?.prs).toHaveLength(1);
  expect(task?.prs[0]).toStrictEqual({ number: 10, url: '', ciStatus: 'pending' });
});

test('it ignores a CI status change when no issue number is present', () => {
  const { store, emit } = setupTest();

  const stateBefore = store.getState();

  emit({
    type: 'ciStatusChanged',
    prNumber: 99,
    oldCIStatus: null,
    newCIStatus: 'pending',
  } satisfies CIStatusChangedEvent);

  expect(store.getState().tasks).toBe(stateBefore.tasks);
});

test('it ignores a CI status change when no task exists for the issue', () => {
  const { store, emit } = setupTest();

  emit({
    type: 'ciStatusChanged',
    prNumber: 10,
    issueNumber: 999,
    oldCIStatus: null,
    newCIStatus: 'failure',
  } satisfies CIStatusChangedEvent);

  expect(store.getState().tasks.size).toBe(0);
});

test('it marks PR detail cache as stale when a CI status change is received', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'review' }));

  const prDetailCache = new Map(store.getState().prDetailCache);
  prDetailCache.set(10, { title: 'PR', changedFilesCount: 2, stale: false });
  store.setState({ prDetailCache });

  emit({
    type: 'ciStatusChanged',
    prNumber: 10,
    issueNumber: 1,
    oldCIStatus: null,
    newCIStatus: 'failure',
  } satisfies CIStatusChangedEvent);

  expect(store.getState().prDetailCache.get(10)?.stale).toBe(true);
});

// ---------------------------------------------------------------------------
// Selectors — sortedTasks
// ---------------------------------------------------------------------------

test('it places action tasks before agent tasks in the sorted list', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'in-progress' }));

  const sorted = selectSortedTasks(store.getState());
  expect(sorted).toHaveLength(2);
  expect(sorted[0]?.section).toBe('action');
  expect(sorted[0]?.task.issueNumber).toBe(1);
  expect(sorted[1]?.section).toBe('agents');
  expect(sorted[1]?.task.issueNumber).toBe(2);
});

test('it assigns all action statuses to the action section', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'approved' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'blocked' }));
  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'needs-refinement' }));
  emit(buildIssueStatusChanged({ issueNumber: 4, newStatus: 'pending' }));

  // Create a crashed task
  emit(buildIssueStatusChanged({ issueNumber: 5, newStatus: 'in-progress' }));
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 5,
    sessionID: 'sess-5',
  } satisfies AgentStartedEvent);
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    error: 'fail',
    sessionID: 'sess-5',
  } satisfies AgentFailedEvent);

  const sorted = selectSortedTasks(store.getState());
  const actionTasks = sorted.filter((s) => s.section === 'action');
  expect(actionTasks).toHaveLength(5);
});

test('it assigns agent-implementing and agent-reviewing to the agents section', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'review' }));

  const sorted = selectSortedTasks(store.getState());
  const agentTasks = sorted.filter((s) => s.section === 'agents');
  expect(agentTasks).toHaveLength(2);
});

test('it sorts by status weight descending within a section', () => {
  const { store, emit } = setupTest();

  // approved (100) should come before blocked (80) should come before pending (50)
  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      newStatus: 'pending',
      priorityLabel: 'priority:high',
    }),
  );
  emit(
    buildIssueStatusChanged({
      issueNumber: 2,
      newStatus: 'blocked',
      priorityLabel: 'priority:high',
    }),
  );
  emit(
    buildIssueStatusChanged({
      issueNumber: 3,
      newStatus: 'approved',
      priorityLabel: 'priority:high',
    }),
  );

  const sorted = selectSortedTasks(store.getState());
  expect(sorted[0]?.task.issueNumber).toBe(3); // approved, weight 100
  expect(sorted[1]?.task.issueNumber).toBe(2); // blocked, weight 80
  expect(sorted[2]?.task.issueNumber).toBe(1); // pending, weight 50
});

test('it sorts by priority weight descending when status weights are equal', () => {
  const { store, emit } = setupTest();

  emit(
    buildIssueStatusChanged({
      issueNumber: 1,
      newStatus: 'pending',
      priorityLabel: 'priority:low',
    }),
  );
  emit(
    buildIssueStatusChanged({
      issueNumber: 2,
      newStatus: 'pending',
      priorityLabel: 'priority:high',
    }),
  );

  const sorted = selectSortedTasks(store.getState());
  expect(sorted[0]?.task.issueNumber).toBe(2); // high priority
  expect(sorted[1]?.task.issueNumber).toBe(1); // low priority
});

test('it sorts by issue number ascending when status and priority are equal', () => {
  const { store, emit } = setupTest();

  emit(
    buildIssueStatusChanged({
      issueNumber: 10,
      newStatus: 'pending',
      priorityLabel: 'priority:medium',
    }),
  );
  emit(
    buildIssueStatusChanged({
      issueNumber: 5,
      newStatus: 'pending',
      priorityLabel: 'priority:medium',
    }),
  );

  const sorted = selectSortedTasks(store.getState());
  expect(sorted[0]?.task.issueNumber).toBe(5);
  expect(sorted[1]?.task.issueNumber).toBe(10);
});

test('it excludes tasks with an unrecognized status label from the sorted list', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'unknown-future-label' }));

  const sorted = selectSortedTasks(store.getState());
  expect(sorted).toHaveLength(1);
  expect(sorted[0]?.task.issueNumber).toBe(1);
});

// ---------------------------------------------------------------------------
// Selectors — actionCount, agentSectionCount, runningAgentCount
// ---------------------------------------------------------------------------

test('it counts action section tasks', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'blocked' }));
  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'in-progress' }));

  expect(selectActionCount(store.getState())).toBe(2);
});

test('it counts agent section tasks', () => {
  const { store, emit } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'in-progress' }));
  emit(buildIssueStatusChanged({ issueNumber: 2, newStatus: 'review' }));
  emit(buildIssueStatusChanged({ issueNumber: 3, newStatus: 'pending' }));

  expect(selectAgentSectionCount(store.getState())).toBe(2);
});

test('it counts running agents including the planner', () => {
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
// Actions — dispatch
// ---------------------------------------------------------------------------

test('it dispatches an implementor for a ready-to-implement task', () => {
  const { store, emit, sentCommands } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  store.getState().dispatch(1);

  expect(sentCommands).toContainEqual({ command: 'dispatchImplementor', issueNumber: 1 });
});

test('it dispatches an implementor when retrying a crashed implementor', () => {
  const { store, emit, sentCommands } = setupTest();

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
    error: 'fail',
    sessionID: 'sess-1',
  } satisfies AgentFailedEvent);

  store.getState().dispatch(1);

  expect(sentCommands).toContainEqual({ command: 'dispatchImplementor', issueNumber: 1 });
});

test('it dispatches a reviewer when retrying a crashed reviewer', () => {
  const { store, emit, sentCommands } = setupTest();

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
    error: 'fail',
    sessionID: 'sess-r-1',
  } satisfies AgentFailedEvent);

  store.getState().dispatch(1);

  expect(sentCommands).toContainEqual({ command: 'dispatchReviewer', issueNumber: 1 });
});

test('it does not dispatch for a blocked task', () => {
  const { store, emit, sentCommands } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'blocked' }));
  store.getState().dispatch(1);

  expect(sentCommands).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Actions — shutdown
// ---------------------------------------------------------------------------

test('it sets the shutting down flag and sends a shutdown command', () => {
  const { store, sentCommands } = setupTest();

  store.getState().shutdown();

  expect(store.getState().shuttingDown).toBe(true);
  expect(sentCommands).toContainEqual({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Actions — selectIssue
// ---------------------------------------------------------------------------

test('it updates the selected issue', () => {
  const { store } = setupTest();

  store.getState().selectIssue(5);
  expect(store.getState().selectedIssue).toBe(5);
});

// ---------------------------------------------------------------------------
// Actions — pinTask
// ---------------------------------------------------------------------------

test('it sets the pinned task and triggers on-demand fetch', () => {
  const { store, emit, engine } = setupTest();

  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));

  store.getState().pinTask(1);

  expect(store.getState().pinnedTask).toBe(1);
  expect(engine.getIssueDetails).toHaveBeenCalledWith(1);
});

// ---------------------------------------------------------------------------
// Actions — cycleFocus
// ---------------------------------------------------------------------------

test('it toggles focus between task list and detail pane', () => {
  const { store } = setupTest();

  expect(store.getState().focusedPane).toBe('taskList');

  store.getState().cycleFocus();
  expect(store.getState().focusedPane).toBe('detailPane');

  store.getState().cycleFocus();
  expect(store.getState().focusedPane).toBe('taskList');
});

// ---------------------------------------------------------------------------
// Stream buffer
// ---------------------------------------------------------------------------

test('it appends stream lines to the buffer keyed by session ID', async () => {
  const { store, emit, engine } = setupTest();

  let resolveStream: () => void;
  const streamDone = new Promise<void>((resolve) => {
    resolveStream = resolve;
  });

  async function* generate(): AsyncGenerator<string> {
    yield 'line1\nline2\n';
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

  const buffer = store.getState().agentStreams.get('sess-1');
  expect(buffer).toStrictEqual(['line1', 'line2']);
});

test('it drops the oldest lines when the stream buffer exceeds the limit', async () => {
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
  await new Promise((r) => setTimeout(r, 0));

  const buffer = store.getState().agentStreams.get('sess-1');
  expect(buffer).toBeDefined();
  expect(buffer?.length).toBe(10_000);
  expect(buffer?.[0]).toBe('chunk-1');
  expect(buffer?.[buffer.length - 1]).toBe('chunk-10000');
});

// ---------------------------------------------------------------------------
// Map immutability for Zustand change detection
// ---------------------------------------------------------------------------

test('it produces a new tasks collection reference on every update', () => {
  const { store, emit } = setupTest();

  const initialMap = store.getState().tasks;
  emit(buildIssueStatusChanged({ issueNumber: 1, newStatus: 'pending' }));
  const updatedMap = store.getState().tasks;

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
