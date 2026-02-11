import { expect, test, vi } from 'vitest';
import type { EngineEvent, IssueStatusChangedEvent, SpecPollerBatchResult } from '../../types.ts';
import { createEventEmitter } from '../event-emitter/create-event-emitter.ts';
import { createDispatch } from './create-dispatch.ts';
import type { AgentManagerDelegate } from './types.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface SetupTestOptions {
  isPlannerRunning?: boolean;
}

function setupTest(options: SetupTestOptions = {}): {
  dispatch: ReturnType<typeof createDispatch>;
  emitter: ReturnType<typeof createEventEmitter>;
  events: EngineEvent[];
  agentManager: AgentManagerDelegate;
  config: { repository: string };
} {
  const emitter = createEventEmitter();
  const events: EngineEvent[] = [];
  emitter.on((event) => {
    events.push(event);
  });

  const agentManager: AgentManagerDelegate = {
    dispatchPlanner: vi.fn().mockResolvedValue(undefined),
    dispatchReviewer: vi.fn().mockResolvedValue(undefined),
    isPlannerRunning: vi.fn().mockReturnValue(options.isPlannerRunning ?? false),
  };

  const config = { repository: 'test-owner/test-repo' };
  const dispatch = createDispatch(emitter, agentManager, config);

  return { dispatch, emitter, events, agentManager, config };
}

function buildIssueStatusChanged(
  overrides: Partial<IssueStatusChangedEvent> = {},
): IssueStatusChangedEvent {
  return {
    type: 'issueStatusChanged',
    issueNumber: 42,
    title: 'Test issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildSpecPollerResult(
  overrides: Partial<SpecPollerBatchResult> = {},
): SpecPollerBatchResult {
  return {
    changes: [],
    commitSHA: 'abc123',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SpecPoller result handling — auto-dispatch Planner
// ---------------------------------------------------------------------------

test('it triggers Planner auto-dispatch when an approved spec changes', async () => {
  const { dispatch, agentManager } = setupTest();

  const result = buildSpecPollerResult({
    changes: [
      {
        filePath: 'docs/specs/workflow/test.md',
        frontmatterStatus: 'approved',
        changeType: 'added',
      },
    ],
  });

  await dispatch.handleSpecPollerResult(result);

  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith(['docs/specs/workflow/test.md']);
});

test('it does not dispatch the Planner for a spec with draft status', async () => {
  const { dispatch, agentManager } = setupTest();

  const result = buildSpecPollerResult({
    changes: [
      {
        filePath: 'docs/specs/workflow/test.md',
        frontmatterStatus: 'draft',
        changeType: 'modified',
      },
    ],
  });

  await dispatch.handleSpecPollerResult(result);

  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();
});

test('it batches multiple approved specs into a single Planner invocation', async () => {
  const { dispatch, agentManager } = setupTest();

  const result = buildSpecPollerResult({
    changes: [
      { filePath: 'docs/specs/workflow/a.md', frontmatterStatus: 'approved', changeType: 'added' },
      { filePath: 'docs/specs/workflow/b.md', frontmatterStatus: 'approved', changeType: 'added' },
      {
        filePath: 'docs/specs/workflow/c.md',
        frontmatterStatus: 'approved',
        changeType: 'modified',
      },
    ],
  });

  await dispatch.handleSpecPollerResult(result);

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);
  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith([
    'docs/specs/workflow/a.md',
    'docs/specs/workflow/b.md',
    'docs/specs/workflow/c.md',
  ]);
});

test('it emits specChanged events for each change regardless of frontmatter status', async () => {
  const { dispatch, events } = setupTest();

  const result = buildSpecPollerResult({
    changes: [
      { filePath: 'docs/specs/workflow/a.md', frontmatterStatus: 'approved', changeType: 'added' },
      { filePath: 'docs/specs/workflow/b.md', frontmatterStatus: 'draft', changeType: 'modified' },
    ],
    commitSHA: 'sha456',
  });

  await dispatch.handleSpecPollerResult(result);

  const specChangedEvents = events.filter((e) => e.type === 'specChanged');
  expect(specChangedEvents).toHaveLength(2);
  expect(specChangedEvents[0]).toStrictEqual({
    type: 'specChanged',
    filePath: 'docs/specs/workflow/a.md',
    frontmatterStatus: 'approved',
    changeType: 'added',
    commitSHA: 'sha456',
  });
  expect(specChangedEvents[1]).toStrictEqual({
    type: 'specChanged',
    filePath: 'docs/specs/workflow/b.md',
    frontmatterStatus: 'draft',
    changeType: 'modified',
    commitSHA: 'sha456',
  });
});

test('it does not dispatch the Planner when there are no changes', async () => {
  const { dispatch, agentManager } = setupTest();

  const result = buildSpecPollerResult({ changes: [] });

  await dispatch.handleSpecPollerResult(result);

  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Planner concurrency guard
// ---------------------------------------------------------------------------

test('it emits agentSkipped and defers paths when Planner is already running', async () => {
  const { dispatch, agentManager, events } = setupTest({ isPlannerRunning: true });

  const result = buildSpecPollerResult({
    changes: [
      {
        filePath: 'docs/specs/workflow/test.md',
        frontmatterStatus: 'approved',
        changeType: 'added',
      },
    ],
  });

  await dispatch.handleSpecPollerResult(result);

  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();
  const skippedEvents = events.filter((e) => e.type === 'agentSkipped');
  expect(skippedEvents).toHaveLength(1);
  expect(skippedEvents[0]).toStrictEqual({
    type: 'agentSkipped',
    agentType: 'planner',
    specPaths: ['docs/specs/workflow/test.md'],
  });
});

test('it merges deferred paths with new cycle results when Planner is no longer running', async () => {
  const { dispatch, agentManager } = setupTest({ isPlannerRunning: true });

  // First cycle -- Planner running, paths deferred
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );
  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Second cycle -- new changes + deferred paths merged
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/b.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);
  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith(
    expect.arrayContaining(['docs/specs/workflow/a.md', 'docs/specs/workflow/b.md']),
  );
  // Verify exactly 2 paths (no extras)
  const callArgs = vi.mocked(agentManager.dispatchPlanner).mock.calls[0];
  expect(callArgs?.[0]).toHaveLength(2);
});

test('it deduplicates paths when the same spec changes across deferred and new cycles', async () => {
  const { dispatch, agentManager } = setupTest({ isPlannerRunning: true });

  // First cycle -- Planner running, path deferred
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Second cycle -- same path changed again
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'modified',
        },
      ],
    }),
  );

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);
  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith(['docs/specs/workflow/a.md']);
});

test('it drops deferred paths whose status changed to non-approved since deferral', async () => {
  const { dispatch, agentManager } = setupTest({ isPlannerRunning: true });

  // First cycle -- approved spec deferred
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Second cycle -- same spec now has draft status
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'draft',
          changeType: 'modified',
        },
      ],
    }),
  );

  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();
});

test('it clears the deferred buffer after successful Planner dispatch', async () => {
  const { dispatch, agentManager } = setupTest({ isPlannerRunning: true });

  // First cycle -- deferred
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Second cycle -- dispatches deferred + new
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/b.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);

  // Planner running again
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(true);

  // Third cycle -- new change, deferred again (buffer was cleared)
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/c.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  // Still only one call from cycle 2
  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Fourth cycle -- only c.md should be dispatched (a.md and b.md were cleared)
  await dispatch.handleSpecPollerResult(buildSpecPollerResult({ changes: [] }));

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(2);
  expect(agentManager.dispatchPlanner).toHaveBeenLastCalledWith(['docs/specs/workflow/c.md']);
});

// ---------------------------------------------------------------------------
// Issue status changed — user-dispatch (dispatchReady)
// ---------------------------------------------------------------------------

test('it emits dispatchReady when an issue enters pending status', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'pending', issueNumber: 10 }),
  );

  const readyEvents = events.filter((e) => e.type === 'dispatchReady');
  expect(readyEvents).toHaveLength(1);
  expect(readyEvents[0]).toStrictEqual({
    type: 'dispatchReady',
    issueNumber: 10,
    statusLabel: 'status:pending',
  });
});

test('it emits dispatchReady when an issue enters unblocked status', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'unblocked', issueNumber: 11 }),
  );

  const readyEvents = events.filter((e) => e.type === 'dispatchReady');
  expect(readyEvents).toHaveLength(1);
  expect(readyEvents[0]).toStrictEqual({
    type: 'dispatchReady',
    issueNumber: 11,
    statusLabel: 'status:unblocked',
  });
});

test('it emits dispatchReady when an issue enters needs-changes status', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'needs-changes', issueNumber: 12 }),
  );

  const readyEvents = events.filter((e) => e.type === 'dispatchReady');
  expect(readyEvents).toHaveLength(1);
  expect(readyEvents[0]).toStrictEqual({
    type: 'dispatchReady',
    issueNumber: 12,
    statusLabel: 'status:needs-changes',
  });
});

// ---------------------------------------------------------------------------
// Issue status changed — notify-only (needs-refinement)
// ---------------------------------------------------------------------------

test('it emits a notification with clipboard command for needs-refinement status', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'needs-refinement', issueNumber: 7 }),
  );

  const notifications = events.filter((e) => e.type === 'notification');
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toStrictEqual({
    type: 'notification',
    issueNumber: 7,
    statusLabel: 'status:needs-refinement',
    clipboardCommand:
      'claude -p "Use /spec-writing to address the spec refinement needed for issue #7. See blocker comment: https://github.com/test-owner/test-repo/issues/7"',
    contextURL: 'https://github.com/test-owner/test-repo/issues/7',
    resolutionGuidance: 'After amending the spec, change the label to status:unblocked.',
  });
});

test('it uses the correct clipboard command format for needs-refinement', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'needs-refinement', issueNumber: 15 }),
  );

  const notification = events.find((e) => e.type === 'notification');
  expect(notification).toBeDefined();
  if (notification?.type === 'notification') {
    expect(notification.clipboardCommand).toBe(
      'claude -p "Use /spec-writing to address the spec refinement needed for issue #15. See blocker comment: https://github.com/test-owner/test-repo/issues/15"',
    );
  }
});

// ---------------------------------------------------------------------------
// Issue status changed — notify-only (blocked)
// ---------------------------------------------------------------------------

test('it emits a notification with issue URL and resolution guidance for blocked status', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'blocked', issueNumber: 8 }),
  );

  const notifications = events.filter((e) => e.type === 'notification');
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toStrictEqual({
    type: 'notification',
    issueNumber: 8,
    statusLabel: 'status:blocked',
    contextURL: 'https://github.com/test-owner/test-repo/issues/8',
    resolutionGuidance: 'After resolving the blocker, change the label to status:unblocked.',
  });
});

// ---------------------------------------------------------------------------
// Issue status changed — notify-only (approved)
// ---------------------------------------------------------------------------

test('it emits a notification with issue URL for approved status', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'approved', issueNumber: 9 }),
  );

  const notifications = events.filter((e) => e.type === 'notification');
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toStrictEqual({
    type: 'notification',
    issueNumber: 9,
    statusLabel: 'status:approved',
    contextURL: 'https://github.com/test-owner/test-repo/issues/9',
  });
});

// ---------------------------------------------------------------------------
// Issue status changed — notification dismissal
// ---------------------------------------------------------------------------

test('it emits notificationDismissed when a notified issue changes status', async () => {
  const { dispatch, events } = setupTest();

  // First: issue enters needs-refinement -> notification emitted
  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'needs-refinement', issueNumber: 20 }),
  );

  // Second: issue status changes to unblocked -> notification dismissed
  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({
      newStatus: 'unblocked',
      issueNumber: 20,
      oldStatus: 'needs-refinement',
    }),
  );

  const dismissedEvents = events.filter((e) => e.type === 'notificationDismissed');
  expect(dismissedEvents).toHaveLength(1);
  expect(dismissedEvents[0]).toStrictEqual({
    type: 'notificationDismissed',
    issueNumber: 20,
  });
});

test('it does not emit notificationDismissed when no notification is active for the issue', async () => {
  const { dispatch, events } = setupTest();

  // Issue enters pending -- no notification was active
  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'pending', issueNumber: 30 }),
  );

  const dismissedEvents = events.filter((e) => e.type === 'notificationDismissed');
  expect(dismissedEvents).toHaveLength(0);
});

test('it dismisses a blocked notification when the issue status changes', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'blocked', issueNumber: 21 }),
  );

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({
      newStatus: 'unblocked',
      issueNumber: 21,
      oldStatus: 'blocked',
    }),
  );

  const dismissedEvents = events.filter((e) => e.type === 'notificationDismissed');
  expect(dismissedEvents).toHaveLength(1);
  expect(dismissedEvents[0]).toStrictEqual({
    type: 'notificationDismissed',
    issueNumber: 21,
  });
});

test('it dismisses an approved notification when the issue status changes', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'approved', issueNumber: 22 }),
  );

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({
      newStatus: 'pending',
      issueNumber: 22,
      oldStatus: 'approved',
    }),
  );

  const dismissedEvents = events.filter((e) => e.type === 'notificationDismissed');
  expect(dismissedEvents).toHaveLength(1);
});

test('it does not emit notificationDismissed twice for the same issue without a new notification', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'blocked', issueNumber: 23 }),
  );

  // First status change dismisses
  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({
      newStatus: 'unblocked',
      issueNumber: 23,
      oldStatus: 'blocked',
    }),
  );

  // Second status change -- no active notification
  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({
      newStatus: 'pending',
      issueNumber: 23,
      oldStatus: 'unblocked',
    }),
  );

  const dismissedEvents = events.filter((e) => e.type === 'notificationDismissed');
  expect(dismissedEvents).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Issue status changed — fallthrough (in-progress, review)
// ---------------------------------------------------------------------------

test('it triggers no dispatch action for in-progress status', async () => {
  const { dispatch, agentManager, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'in-progress', issueNumber: 50 }),
  );

  expect(agentManager.dispatchReviewer).not.toHaveBeenCalled();
  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();

  const dispatchEvents = events.filter(
    (e) => e.type === 'dispatchReady' || e.type === 'notification' || e.type === 'agentSkipped',
  );
  expect(dispatchEvents).toHaveLength(0);
});

test('it triggers no dispatch action for review status', async () => {
  const { dispatch, agentManager, events } = setupTest();

  await dispatch.handleIssueStatusChanged(
    buildIssueStatusChanged({ newStatus: 'review', issueNumber: 51 }),
  );

  expect(agentManager.dispatchReviewer).not.toHaveBeenCalled();
  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();

  const dispatchEvents = events.filter(
    (e) => e.type === 'dispatchReady' || e.type === 'notification' || e.type === 'agentSkipped',
  );
  expect(dispatchEvents).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Planner failure — re-deferral of spec paths
// ---------------------------------------------------------------------------

test('it re-adds dispatched spec paths to the deferred buffer when Planner fails', async () => {
  const { dispatch, agentManager } = setupTest();

  // Dispatch Planner with approved spec
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );
  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);

  // Planner fails -- re-add paths
  dispatch.handlePlannerFailed(['docs/specs/workflow/a.md']);

  // Next cycle with no new changes -- deferred path dispatched
  vi.mocked(agentManager.dispatchPlanner).mockClear();
  await dispatch.handleSpecPollerResult(buildSpecPollerResult({ changes: [] }));

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);
  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith(['docs/specs/workflow/a.md']);
});

test('it merges re-deferred paths with new spec changes on the next cycle', async () => {
  const { dispatch, agentManager } = setupTest();

  // Dispatch Planner
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );
  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);

  // Planner fails -- re-add paths
  dispatch.handlePlannerFailed(['docs/specs/workflow/a.md']);

  // Next cycle with new changes -- merged
  vi.mocked(agentManager.dispatchPlanner).mockClear();
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/b.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);
  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith(
    expect.arrayContaining(['docs/specs/workflow/a.md', 'docs/specs/workflow/b.md']),
  );
  const callArgs = vi.mocked(agentManager.dispatchPlanner).mock.calls[0];
  expect(callArgs?.[0]).toHaveLength(2);
});

test('it drops re-deferred paths whose frontmatter status changed to non-approved', async () => {
  const { dispatch, agentManager } = setupTest();

  // Dispatch Planner
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );
  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);

  // Planner fails -- re-add paths
  dispatch.handlePlannerFailed(['docs/specs/workflow/a.md']);

  // Next cycle -- spec status changed to draft
  vi.mocked(agentManager.dispatchPlanner).mockClear();
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'draft',
          changeType: 'modified',
        },
      ],
    }),
  );

  expect(agentManager.dispatchPlanner).not.toHaveBeenCalled();
});

test('it deduplicates re-deferred paths with existing deferred paths', async () => {
  const { dispatch, agentManager } = setupTest({ isPlannerRunning: true });

  // First cycle -- Planner running, path deferred
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'added',
        },
      ],
    }),
  );

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Second cycle -- dispatches deferred
  await dispatch.handleSpecPollerResult(buildSpecPollerResult({ changes: [] }));
  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);

  // Planner fails -- re-add a.md
  dispatch.handlePlannerFailed(['docs/specs/workflow/a.md']);

  // Planner running again briefly
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(true);

  // Third cycle -- a.md deferred again, plus new a.md from spec changes (duplicate)
  await dispatch.handleSpecPollerResult(
    buildSpecPollerResult({
      changes: [
        {
          filePath: 'docs/specs/workflow/a.md',
          frontmatterStatus: 'approved',
          changeType: 'modified',
        },
      ],
    }),
  );

  // Planner finishes
  vi.mocked(agentManager.isPlannerRunning).mockReturnValue(false);

  // Fourth cycle -- should dispatch exactly one copy of a.md
  vi.mocked(agentManager.dispatchPlanner).mockClear();
  await dispatch.handleSpecPollerResult(buildSpecPollerResult({ changes: [] }));

  expect(agentManager.dispatchPlanner).toHaveBeenCalledTimes(1);
  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith(['docs/specs/workflow/a.md']);
});

// ---------------------------------------------------------------------------
// Mixed batch: approved and non-approved specs
// ---------------------------------------------------------------------------

test('it only includes approved specs in the Planner dispatch from a mixed batch', async () => {
  const { dispatch, agentManager } = setupTest();

  const result = buildSpecPollerResult({
    changes: [
      { filePath: 'docs/specs/workflow/a.md', frontmatterStatus: 'approved', changeType: 'added' },
      { filePath: 'docs/specs/workflow/b.md', frontmatterStatus: 'draft', changeType: 'modified' },
      { filePath: 'docs/specs/workflow/c.md', frontmatterStatus: 'approved', changeType: 'added' },
    ],
  });

  await dispatch.handleSpecPollerResult(result);

  expect(agentManager.dispatchPlanner).toHaveBeenCalledWith([
    'docs/specs/workflow/a.md',
    'docs/specs/workflow/c.md',
  ]);
});
