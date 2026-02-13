import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import type { EngineEvent } from '../../types.ts';
import { createEventEmitter } from '../event-emitter/create-event-emitter.ts';
import { createRecovery } from './create-recovery.ts';
import type { IssuePollerSnapshot, IssueSnapshotEntry } from './types.ts';

function setupTest(): {
  octokit: ReturnType<typeof createMockGitHubClient>;
  emitter: ReturnType<typeof createEventEmitter>;
  events: EngineEvent[];
  recovery: ReturnType<typeof createRecovery>;
} {
  const octokit = createMockGitHubClient();
  const emitter = createEventEmitter();
  const events: EngineEvent[] = [];
  emitter.on((event) => {
    events.push(event);
  });

  const recovery = createRecovery({
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
    emitter,
  });

  return { octokit, emitter, events, recovery };
}

function createSnapshot(entries?: Map<number, IssueSnapshotEntry>): IssuePollerSnapshot {
  const map = entries ?? new Map<number, IssueSnapshotEntry>();
  return {
    get: (issueNumber: number): IssueSnapshotEntry | undefined => map.get(issueNumber),
    set: (issueNumber: number, entry: IssueSnapshotEntry): void => {
      map.set(issueNumber, entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Startup Recovery
// ---------------------------------------------------------------------------

test('it resets in-progress issues to pending on startup', async () => {
  const { octokit, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      {
        number: 10,
        title: 'Task 10',
        body: 'body',
        labels: [
          { name: 'task:implement' },
          { name: 'status:in-progress' },
          { name: 'priority:high' },
        ],
        created_at: '2026-01-15T00:00:00Z',
      },
    ],
  });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  const result = await recovery.performStartupRecovery();

  expect(result.recoveriesPerformed).toBe(1);
  expect(octokit.issues.removeLabel).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    issue_number: 10,
    name: 'status:in-progress',
  });
  expect(octokit.issues.addLabels).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    issue_number: 10,
    labels: ['status:pending'],
  });
});

test('it emits synthetic issueStatusChanged with isRecovery true during startup', async () => {
  const { octokit, events, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      {
        number: 10,
        title: 'Task 10',
        body: 'body',
        labels: [
          { name: 'task:implement' },
          { name: 'status:in-progress' },
          { name: 'priority:high' },
        ],
        created_at: '2026-01-15T00:00:00Z',
      },
    ],
  });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performStartupRecovery();

  const statusEvents = events.filter((e) => e.type === 'issueStatusChanged');
  expect(statusEvents).toStrictEqual([
    {
      type: 'issueStatusChanged',
      issueNumber: 10,
      title: 'Task 10',
      oldStatus: 'in-progress',
      newStatus: 'pending',
      priorityLabel: 'priority:high',
      createdAt: '2026-01-15T00:00:00Z',
      isRecovery: true,
    },
  ]);
});

test('it populates synthetic events from the GitHub API response during startup', async () => {
  const { octokit, events, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      {
        number: 42,
        title: 'A specific task title',
        body: 'body',
        labels: [{ name: 'priority:low' }, { name: 'status:in-progress' }],
        created_at: '2026-02-01T12:30:00Z',
      },
    ],
  });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performStartupRecovery();

  const statusEvent = events.find((e) => e.type === 'issueStatusChanged');
  expect(statusEvent).toMatchObject({
    title: 'A specific task title',
    priorityLabel: 'priority:low',
    createdAt: '2026-02-01T12:30:00Z',
  });
});

test('it handles multiple in-progress issues during startup', async () => {
  const { octokit, events, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      {
        number: 10,
        title: 'Task 10',
        body: 'body',
        labels: [{ name: 'status:in-progress' }, { name: 'priority:medium' }],
        created_at: '2026-01-10T00:00:00Z',
      },
      {
        number: 20,
        title: 'Task 20',
        body: 'body',
        labels: [{ name: 'status:in-progress' }, { name: 'priority:high' }],
        created_at: '2026-01-20T00:00:00Z',
      },
    ],
  });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  const result = await recovery.performStartupRecovery();

  expect(result.recoveriesPerformed).toBe(2);
  expect(octokit.issues.removeLabel).toHaveBeenCalledTimes(2);
  expect(octokit.issues.addLabels).toHaveBeenCalledTimes(2);

  const statusEvents = events.filter((e) => e.type === 'issueStatusChanged');
  expect(statusEvents).toHaveLength(2);
});

test('it returns zero recoveries when no in-progress issues exist at startup', async () => {
  const { octokit, events, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({ data: [] });

  const result = await recovery.performStartupRecovery();

  expect(result.recoveriesPerformed).toBe(0);
  expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
  expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});

test('it queries GitHub with the correct labels filter during startup', async () => {
  const { octokit, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({ data: [] });

  await recovery.performStartupRecovery();

  expect(octokit.issues.listForRepo).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    labels: 'task:implement,status:in-progress',
    state: 'open',
    per_page: 100,
  });
});

test('it handles string labels in the GitHub API response during startup', async () => {
  const { octokit, events, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      {
        number: 5,
        title: 'String labels task',
        body: 'body',
        labels: ['status:in-progress', 'priority:critical'],
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performStartupRecovery();

  const statusEvent = events.find((e) => e.type === 'issueStatusChanged');
  expect(statusEvent).toMatchObject({
    priorityLabel: 'priority:critical',
  });
});

test('it defaults priority label to empty string when none is present during startup', async () => {
  const { octokit, events, recovery } = setupTest();

  vi.mocked(octokit.issues.listForRepo).mockResolvedValue({
    data: [
      {
        number: 5,
        title: 'No priority task',
        body: 'body',
        labels: [{ name: 'status:in-progress' }],
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performStartupRecovery();

  const statusEvent = events.find((e) => e.type === 'issueStatusChanged');
  expect(statusEvent).toMatchObject({
    priorityLabel: '',
  });
});

// ---------------------------------------------------------------------------
// Crash Recovery — Implementor
// ---------------------------------------------------------------------------

test('it resets in-progress issues to pending after implementor session completes', async () => {
  const { octokit, recovery } = setupTest();

  const snapshot = createSnapshot(
    new Map([
      [
        10,
        {
          issueNumber: 10,
          title: 'Task 10',
          statusLabel: 'in-progress',
          priorityLabel: 'priority:medium',
          complexityLabel: '',
          createdAt: '2026-01-15T00:00:00Z',
        },
      ],
    ]),
  );

  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performCrashRecovery({
    agentType: 'implementor',
    issueNumber: 10,
    snapshot,
  });

  expect(octokit.issues.removeLabel).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    issue_number: 10,
    name: 'status:in-progress',
  });
  expect(octokit.issues.addLabels).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    issue_number: 10,
    labels: ['status:pending'],
  });
});

test('it emits only synthetic issueStatusChanged after crash recovery', async () => {
  const { octokit, events, recovery } = setupTest();

  const snapshot = createSnapshot(
    new Map([
      [
        10,
        {
          issueNumber: 10,
          title: 'Task 10',
          statusLabel: 'in-progress',
          priorityLabel: 'priority:medium',
          complexityLabel: '',
          createdAt: '2026-01-15T00:00:00Z',
        },
      ],
    ]),
  );

  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performCrashRecovery({
    agentType: 'implementor',
    issueNumber: 10,
    snapshot,
  });

  expect(events).toStrictEqual([
    {
      type: 'issueStatusChanged',
      issueNumber: 10,
      title: 'Task 10',
      oldStatus: 'in-progress',
      newStatus: 'pending',
      priorityLabel: 'priority:medium',
      createdAt: '2026-01-15T00:00:00Z',
      isRecovery: true,
    },
  ]);
});

test('it populates synthetic events from the IssuePoller snapshot during crash recovery', async () => {
  const { octokit, events, recovery } = setupTest();

  const snapshot = createSnapshot(
    new Map([
      [
        42,
        {
          issueNumber: 42,
          title: 'Specific snapshot title',
          statusLabel: 'in-progress',
          priorityLabel: 'priority:high',
          complexityLabel: '',
          createdAt: '2026-02-05T08:00:00Z',
        },
      ],
    ]),
  );

  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performCrashRecovery({
    agentType: 'implementor',
    issueNumber: 42,
    snapshot,
  });

  const statusEvent = events.find((e) => e.type === 'issueStatusChanged');
  expect(statusEvent).toMatchObject({
    title: 'Specific snapshot title',
    priorityLabel: 'priority:high',
    createdAt: '2026-02-05T08:00:00Z',
  });
});

test('it updates the IssuePoller snapshot to reflect pending status after crash recovery', async () => {
  const { octokit, recovery } = setupTest();

  const entries = new Map<number, IssueSnapshotEntry>([
    [
      10,
      {
        issueNumber: 10,
        title: 'Task 10',
        statusLabel: 'in-progress',
        priorityLabel: 'priority:medium',
        complexityLabel: '',
        createdAt: '2026-01-15T00:00:00Z',
      },
    ],
  ]);
  const snapshot = createSnapshot(entries);

  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: undefined });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: undefined });

  await recovery.performCrashRecovery({
    agentType: 'implementor',
    issueNumber: 10,
    snapshot,
  });

  const updated = entries.get(10);
  expect(updated?.statusLabel).toBe('pending');
});

test('it skips crash recovery when the issue is not in-progress', async () => {
  const { octokit, events, recovery } = setupTest();

  const snapshot = createSnapshot(
    new Map([
      [
        10,
        {
          issueNumber: 10,
          title: 'Task 10',
          statusLabel: 'review',
          priorityLabel: 'priority:medium',
          complexityLabel: '',
          createdAt: '2026-01-15T00:00:00Z',
        },
      ],
    ]),
  );

  await recovery.performCrashRecovery({
    agentType: 'implementor',
    issueNumber: 10,
    snapshot,
  });

  expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
  expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});

test('it skips crash recovery when the issue is not in the snapshot', async () => {
  const { octokit, events, recovery } = setupTest();

  const snapshot = createSnapshot();

  await recovery.performCrashRecovery({
    agentType: 'implementor',
    issueNumber: 99,
    snapshot,
  });

  expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
  expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Crash Recovery — Reviewer (skipped)
// ---------------------------------------------------------------------------

test('it skips crash recovery for reviewer sessions', async () => {
  const { octokit, events, recovery } = setupTest();

  const snapshot = createSnapshot(
    new Map([
      [
        10,
        {
          issueNumber: 10,
          title: 'Task 10',
          statusLabel: 'in-progress',
          priorityLabel: 'priority:medium',
          complexityLabel: '',
          createdAt: '2026-01-15T00:00:00Z',
        },
      ],
    ]),
  );

  await recovery.performCrashRecovery({
    agentType: 'reviewer',
    issueNumber: 10,
    snapshot,
  });

  expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
  expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Crash Recovery — Planner (skipped)
// ---------------------------------------------------------------------------

test('it skips crash recovery for planner sessions', async () => {
  const { octokit, events, recovery } = setupTest();

  const snapshot = createSnapshot();

  await recovery.performCrashRecovery({
    agentType: 'planner',
    issueNumber: 0,
    snapshot,
  });

  expect(octokit.issues.removeLabel).not.toHaveBeenCalled();
  expect(octokit.issues.addLabels).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});
