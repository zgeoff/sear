import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import type { EngineEvent, IssueStatusChangedEvent } from '../../types.ts';
import { createEventEmitter } from '../event-emitter/create-event-emitter.ts';
import type { IssueData } from '../github-client/types.ts';
import { createIssuePoller } from './create-issue-poller.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SetupOptions {
  issues?: IssueData[];
  logError?: (message: string, error: unknown) => void;
}

function buildIssue(overrides: Partial<IssueData> & { number: number }): IssueData {
  return {
    title: `Issue #${overrides.number}`,
    body: null,
    labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:medium' }],
    created_at: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

function setupTest(options: SetupOptions = {}): {
  octokit: ReturnType<typeof createMockGitHubClient>;
  emitter: ReturnType<typeof createEventEmitter>;
  events: EngineEvent[];
  poller: ReturnType<typeof createIssuePoller>;
} {
  const octokit = createMockGitHubClient();
  const emitter = createEventEmitter();
  const events: EngineEvent[] = [];
  emitter.on((event) => {
    events.push(event);
  });

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: options.issues ?? [],
  });

  const poller = createIssuePoller({
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
    emitter,
    logError: options.logError ?? vi.fn(),
  });

  return { octokit, emitter, events, poller };
}

function statusChangedEvents(events: EngineEvent[]): IssueStatusChangedEvent[] {
  return events.filter((e): e is IssueStatusChangedEvent => e.type === 'issueStatusChanged');
}

function removedEvents(events: EngineEvent[]): IssueStatusChangedEvent[] {
  return events.filter(
    (e): e is IssueStatusChangedEvent => e.type === 'issueStatusChanged' && e.newStatus === null,
  );
}

// ---------------------------------------------------------------------------
// IssuePoller — queries GitHub Issues with task:implement label
// ---------------------------------------------------------------------------

test('it queries open issues with the task:implement label on each poll', async () => {
  const { octokit, poller } = setupTest();
  await poller.poll();

  expect(octokit.issues.listForRepo).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: 'test-owner',
      repo: 'test-repo',
      state: 'open',
      labels: 'task:implement',
    }),
  );
});

// ---------------------------------------------------------------------------
// IssuePoller — initial poll emits issueStatusChanged with oldStatus: null
// ---------------------------------------------------------------------------

test('it emits issueStatusChanged with oldStatus null for each issue on the first poll', async () => {
  const issues = [
    buildIssue({ number: 1, title: 'First task' }),
    buildIssue({
      number: 2,
      title: 'Second task',
      labels: [{ name: 'task:implement' }, { name: 'status:review' }, { name: 'priority:high' }],
    }),
  ];

  const { events, poller } = setupTest({ issues });
  await poller.poll();

  const changed = statusChangedEvents(events);
  expect(changed).toHaveLength(2);

  expect(changed[0]).toStrictEqual({
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'First task',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-02-01T00:00:00Z',
  });

  expect(changed[1]).toStrictEqual({
    type: 'issueStatusChanged',
    issueNumber: 2,
    title: 'Second task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:high',
    createdAt: '2026-02-01T00:00:00Z',
  });
});

// ---------------------------------------------------------------------------
// IssuePoller — status label change emits issueStatusChanged
// ---------------------------------------------------------------------------

test('it emits issueStatusChanged when the status label changes between polls', async () => {
  const issue = buildIssue({ number: 1, title: 'My task' });
  const { octokit, events, poller } = setupTest({ issues: [issue] });

  // First poll — detects new issue
  await poller.poll();
  events.length = 0;

  // Simulate status label change
  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      buildIssue({
        number: 1,
        title: 'My task',
        labels: [
          { name: 'task:implement' },
          { name: 'status:in-progress' },
          { name: 'priority:medium' },
        ],
      }),
    ],
  });

  await poller.poll();

  const changed = statusChangedEvents(events);
  expect(changed).toHaveLength(1);
  expect(changed[0]).toStrictEqual(
    expect.objectContaining({
      issueNumber: 1,
      oldStatus: 'pending',
      newStatus: 'in-progress',
    }),
  );
});

// ---------------------------------------------------------------------------
// IssuePoller — title/priority change alone does not emit event
// ---------------------------------------------------------------------------

test('it does not emit issueStatusChanged when only the title or priority changes', async () => {
  const issue = buildIssue({ number: 1, title: 'Original title' });
  const { octokit, events, poller } = setupTest({ issues: [issue] });

  // First poll
  await poller.poll();
  events.length = 0;

  // Change title and priority but keep same status
  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      buildIssue({
        number: 1,
        title: 'Updated title',
        labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:high' }],
      }),
    ],
  });

  await poller.poll();

  expect(statusChangedEvents(events)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// IssuePoller — snapshot tracks title and priority updates
// ---------------------------------------------------------------------------

test('it updates the snapshot with new title and priority even without emitting events', async () => {
  const issue = buildIssue({ number: 1, title: 'Original title' });
  const { octokit, poller } = setupTest({ issues: [issue] });

  await poller.poll();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      buildIssue({
        number: 1,
        title: 'Updated title',
        labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:high' }],
      }),
    ],
  });

  await poller.poll();

  const snap = poller.getSnapshot().get(1);
  expect(snap?.title).toBe('Updated title');
  expect(snap?.priorityLabel).toBe('priority:high');
});

// ---------------------------------------------------------------------------
// IssuePoller — removed issue emits issueStatusChanged with null newStatus
// ---------------------------------------------------------------------------

test('it emits issueStatusChanged with null newStatus when an issue disappears from the poll results', async () => {
  const issues = [buildIssue({ number: 1 }), buildIssue({ number: 2 })];
  const { octokit, events, poller } = setupTest({ issues });

  await poller.poll();
  events.length = 0;

  // Issue #2 disappears (closed or label removed)
  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [buildIssue({ number: 1 })],
  });

  await poller.poll();

  const removed = removedEvents(events);
  expect(removed).toHaveLength(1);
  expect(removed[0]).toMatchObject({ type: 'issueStatusChanged', issueNumber: 2, newStatus: null });
});

// ---------------------------------------------------------------------------
// IssuePoller — removed issue is cleared from snapshot
// ---------------------------------------------------------------------------

test('it removes the issue from the snapshot when a removal event is emitted', async () => {
  const issues = [buildIssue({ number: 1 }), buildIssue({ number: 2 })];
  const { octokit, poller } = setupTest({ issues });

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(2);

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [buildIssue({ number: 1 })],
  });

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(1);
  expect(poller.getSnapshot().has(2)).toBe(false);
});

// ---------------------------------------------------------------------------
// IssuePoller — API error skips cycle without crashing
// ---------------------------------------------------------------------------

test('it skips the cycle and does not crash on GitHub API error', async () => {
  const { octokit, events, poller } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockRejectedValue(
    new Error('GitHub API rate limit exceeded'),
  );

  await poller.poll();

  expect(events).toHaveLength(0);
  expect(poller.getSnapshot().size).toBe(0);
});

// ---------------------------------------------------------------------------
// IssuePoller — API error does not clear existing snapshot
// ---------------------------------------------------------------------------

test('it preserves the existing snapshot when an API error occurs', async () => {
  const issues = [buildIssue({ number: 1 })];
  const { octokit, poller } = setupTest({ issues });

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(1);

  vi.mocked(octokit.issues.listForRepo).mockRejectedValue(new Error('Network error'));

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(1);
  expect(poller.getSnapshot().get(1)?.title).toBe('Issue #1');
});

// ---------------------------------------------------------------------------
// IssuePoller — snapshot stores required fields
// ---------------------------------------------------------------------------

test('it stores issue number, title, status label, priority label, and creation date in the snapshot', async () => {
  const issues = [
    buildIssue({
      number: 42,
      title: 'Implement feature X',
      labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:high' }],
      created_at: '2026-01-15T10:30:00Z',
    }),
  ];

  const { poller } = setupTest({ issues });
  await poller.poll();

  const snap = poller.getSnapshot().get(42);
  expect(snap).toStrictEqual({
    issueNumber: 42,
    title: 'Implement feature X',
    statusLabel: 'pending',
    priorityLabel: 'priority:high',
    complexityLabel: '',
    createdAt: '2026-01-15T10:30:00Z',
  });
});

// ---------------------------------------------------------------------------
// IssuePoller — event payload includes all required fields
// ---------------------------------------------------------------------------

test('it includes issue number, title, old status, new status, priority label, and creation date in the event payload', async () => {
  const issues = [
    buildIssue({
      number: 7,
      title: 'Important task',
      labels: [{ name: 'task:implement' }, { name: 'status:review' }, { name: 'priority:high' }],
      created_at: '2026-02-05T12:00:00Z',
    }),
  ];

  const { events, poller } = setupTest({ issues });
  await poller.poll();

  const changed = statusChangedEvents(events);
  expect(changed).toHaveLength(1);
  expect(changed[0]).toStrictEqual({
    type: 'issueStatusChanged',
    issueNumber: 7,
    title: 'Important task',
    oldStatus: null,
    newStatus: 'review',
    priorityLabel: 'priority:high',
    createdAt: '2026-02-05T12:00:00Z',
  });
});

// ---------------------------------------------------------------------------
// IssuePoller — no events on subsequent poll with no changes
// ---------------------------------------------------------------------------

test('it emits no events on subsequent polls when nothing has changed', async () => {
  const issues = [buildIssue({ number: 1 })];
  const { events, poller } = setupTest({ issues });

  await poller.poll();
  events.length = 0;

  await poller.poll();

  expect(events).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// IssuePoller — handles issues with no status label
// ---------------------------------------------------------------------------

test('it handles issues that have no status label gracefully', async () => {
  const issues = [
    buildIssue({
      number: 1,
      labels: [{ name: 'task:implement' }],
    }),
  ];

  const { events, poller } = setupTest({ issues });
  await poller.poll();

  const changed = statusChangedEvents(events);
  expect(changed).toHaveLength(1);
  expect(changed[0]?.newStatus).toBe('');
  expect(poller.getSnapshot().get(1)?.statusLabel).toBe('');
});

// ---------------------------------------------------------------------------
// IssuePoller — handles string labels
// ---------------------------------------------------------------------------

test('it extracts labels correctly when they are plain strings', async () => {
  const issues = [
    buildIssue({
      number: 1,
      labels: ['task:implement', 'status:blocked', 'priority:low'],
    }),
  ];

  const { events, poller } = setupTest({ issues });
  await poller.poll();

  const changed = statusChangedEvents(events);
  expect(changed[0]?.newStatus).toBe('blocked');
  expect(poller.getSnapshot().get(1)?.priorityLabel).toBe('priority:low');
});

// ---------------------------------------------------------------------------
// IssuePoller — status changes emit before removals
// ---------------------------------------------------------------------------

test('it emits status change events before removal events', async () => {
  const issues = [buildIssue({ number: 1 }), buildIssue({ number: 2 })];
  const { octokit, events, poller } = setupTest({ issues });

  await poller.poll();
  events.length = 0;

  // Issue #2 is removed and issue #3 appears
  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [buildIssue({ number: 1 }), buildIssue({ number: 3, title: 'New task' })],
  });

  await poller.poll();

  // Issue #3 status change should come before issue #2 removal
  const statusIdx = events.findIndex((e) => e.type === 'issueStatusChanged');
  const removedIdx = events.findIndex(
    (e) => e.type === 'issueStatusChanged' && 'newStatus' in e && e.newStatus === null,
  );
  expect(statusIdx).toBeLessThan(removedIdx);
});

// ---------------------------------------------------------------------------
// IssuePoller — getSnapshot returns a read-only view
// ---------------------------------------------------------------------------

test('it returns a snapshot that reflects the latest poll results', async () => {
  const issues = [buildIssue({ number: 1 }), buildIssue({ number: 2 })];
  const { poller } = setupTest({ issues });

  // Before any poll
  expect(poller.getSnapshot().size).toBe(0);

  await poller.poll();
  expect(poller.getSnapshot().size).toBe(2);
});

// ---------------------------------------------------------------------------
// IssuePoller — updateEntry updates the snapshot without emitting events
// ---------------------------------------------------------------------------

test('it updates the status label in the snapshot when updateEntry is called', async () => {
  const issues = [buildIssue({ number: 1 })];
  const { poller } = setupTest({ issues });

  await poller.poll();
  expect(poller.getSnapshot().get(1)?.statusLabel).toBe('pending');

  poller.updateEntry(1, { statusLabel: 'review' });

  expect(poller.getSnapshot().get(1)?.statusLabel).toBe('review');
});

test('it preserves other snapshot fields when updateEntry changes the status label', async () => {
  const issues = [
    buildIssue({
      number: 1,
      title: 'My task',
      labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:high' }],
      created_at: '2026-01-15T10:30:00Z',
    }),
  ];
  const { poller } = setupTest({ issues });

  await poller.poll();

  poller.updateEntry(1, { statusLabel: 'review' });

  const snap = poller.getSnapshot().get(1);
  expect(snap).toStrictEqual({
    issueNumber: 1,
    title: 'My task',
    statusLabel: 'review',
    priorityLabel: 'priority:high',
    complexityLabel: '',
    createdAt: '2026-01-15T10:30:00Z',
  });
});

test('it is a no-op when updateEntry is called for an issue not in the snapshot', async () => {
  const { poller } = setupTest();

  await poller.poll();

  // Should not throw
  poller.updateEntry(999, { statusLabel: 'review' });

  expect(poller.getSnapshot().size).toBe(0);
});

test('it prevents a duplicate issueStatusChanged when the poller runs after updateEntry', async () => {
  const issues = [
    buildIssue({
      number: 1,
      labels: [
        { name: 'task:implement' },
        { name: 'status:in-progress' },
        { name: 'priority:medium' },
      ],
    }),
  ];
  const { octokit, events, poller } = setupTest({ issues });

  // First poll — detects new issue
  await poller.poll();
  events.length = 0;

  // Simulate completion-dispatch: update snapshot to status:review
  poller.updateEntry(1, { statusLabel: 'review' });

  // Simulate next poll: GitHub now returns the issue as status:review
  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      buildIssue({
        number: 1,
        labels: [
          { name: 'task:implement' },
          { name: 'status:review' },
          { name: 'priority:medium' },
        ],
      }),
    ],
  });

  await poller.poll();

  // No issueStatusChanged should be emitted because the snapshot already has status:review
  const changed = statusChangedEvents(events);
  expect(changed).toHaveLength(0);
});
