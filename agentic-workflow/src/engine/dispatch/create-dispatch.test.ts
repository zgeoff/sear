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

test('it defers paths silently when Planner is already running', async () => {
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
  // Only specChanged events, no agentSkipped
  const nonSpecEvents = events.filter((e) => e.type !== 'specChanged');
  expect(nonSpecEvents).toHaveLength(0);
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
// Issue status changed — no granular events emitted
// ---------------------------------------------------------------------------

test('it emits no events for any issue status change', async () => {
  const { dispatch, events } = setupTest();

  const statuses = [
    'pending',
    'unblocked',
    'needs-changes',
    'in-progress',
    'review',
    'needs-refinement',
    'blocked',
    'approved',
  ];

  await Promise.all(
    statuses.map((status) =>
      dispatch.handleIssueStatusChanged(
        buildIssueStatusChanged({ newStatus: status, issueNumber: 42 }),
      ),
    ),
  );

  expect(events).toHaveLength(0);
});

test('it handles issue status changed with null new status without error', async () => {
  const { dispatch, events } = setupTest();

  await dispatch.handleIssueStatusChanged(buildIssueStatusChanged({ newStatus: null }));

  expect(events).toHaveLength(0);
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
