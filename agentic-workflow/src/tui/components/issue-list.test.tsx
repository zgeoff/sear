import { render } from 'ink-testing-library';
import { expect, test, vi } from 'vitest';
import type { EngineEvent } from '../../types.ts';
import { createTUIStore } from '../store.ts';
import { createMockEngine } from '../test-utils/create-mock-engine.ts';
import {
  computeSectionCapacities,
  getCIStatusColor,
  getIssuePriorityColor,
  getVisibleTasks,
  getWorstCIStatus,
  IssueList,
} from './issue-list.tsx';

function setupTest(config?: { paneHeight?: number; paneWidth?: number }): ReturnType<
  typeof render
> & {
  store: ReturnType<typeof createTUIStore>;
  emit: (event: EngineEvent) => void;
} {
  const { engine, emit } = createMockEngine();
  const store = createTUIStore({ engine });
  const paneHeight = config?.paneHeight ?? 20;
  const paneWidth = config?.paneWidth ?? 60;

  const instance = render(
    <IssueList store={store} paneWidth={paneWidth} paneHeight={paneHeight} />,
  );

  return { ...instance, store, emit };
}

function addIssue(
  emit: (event: EngineEvent) => void,
  issueNumber: number,
  overrides?: {
    title?: string;
    status?: string;
    priority?: string;
    createdAt?: string;
  },
): void {
  emit({
    type: 'issueStatusChanged',
    issueNumber,
    title: overrides?.title ?? `Issue ${issueNumber}`,
    oldStatus: null,
    newStatus: overrides?.status ?? 'pending',
    priorityLabel: overrides?.priority ?? 'priority:medium',
    createdAt: overrides?.createdAt ?? '2026-01-01T00:00:00Z',
  });
}

// ---------------------------------------------------------------------------
// Section Headers
// ---------------------------------------------------------------------------

test('it renders ACTION and AGENTS section headers even when empty', () => {
  const { lastFrame } = setupTest();

  const frame = lastFrame() ?? '';
  expect(frame).toContain('ACTION (0)');
  expect(frame).toContain('AGENTS (0)');
});

test('it shows the correct count in section headers', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'pending' });
  addIssue(emit, 2, { status: 'blocked' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTION (2)');
    expect(frame).toContain('AGENTS (0)');
  });
});

test('it shows AGENTS count when agent tasks exist', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTION (0)');
    expect(frame).toContain('AGENTS (1)');
  });
});

// ---------------------------------------------------------------------------
// Row Format
// ---------------------------------------------------------------------------

test('it renders the issue number in the row', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 42, { title: 'My feature' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('#42');
  });
});

test('it renders the status label in the row', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'pending' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('DISPATCH');
  });
});

test('it renders APPROVED status for approved tasks', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'approved' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('APPROVED');
  });
});

test('it renders FAILED status for crashed tasks', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });
  emit({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 1,
    error: 'boom',
    sessionID: 'sess-1',
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('FAILED');
  });
});

test('it renders WIP with agent count for implementing tasks', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('WIP(1)');
  });
});

test('it renders the title in the row', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { title: 'Feature X' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Feature X');
  });
});

// ---------------------------------------------------------------------------
// PR Column
// ---------------------------------------------------------------------------

test('it shows a dash when no PRs are linked', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1);

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('\u2014');
  });
});

test('it shows PR number when one PR is linked', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1);
  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 482,
    url: 'https://github.com/owner/repo/pull/482',
    ciStatus: null,
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('PR#482');
  });
});

test('it shows PR count when multiple PRs are linked', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1);
  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 10,
    url: 'https://github.com/owner/repo/pull/10',
    ciStatus: null,
  });
  emit({
    type: 'prLinked',
    issueNumber: 1,
    prNumber: 11,
    url: 'https://github.com/owner/repo/pull/11',
    ciStatus: null,
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('PRx2');
  });
});

// ---------------------------------------------------------------------------
// Section Assignment
// ---------------------------------------------------------------------------

test('it places ready-to-implement tasks in the ACTION section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'pending', title: 'Ready' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTION (1)');
    expect(frame).toContain('AGENTS (0)');
  });
});

test('it places blocked tasks in the ACTION section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'blocked' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTION (1)');
  });
});

test('it places needs-refinement tasks in the ACTION section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'needs-refinement' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTION (1)');
  });
});

test('it places approved tasks in the ACTION section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'approved' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('ACTION (1)');
  });
});

test('it places agent-implementing tasks in the AGENTS section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'in-progress' });
  emit({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 1,
    sessionID: 'sess-1',
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('AGENTS (1)');
  });
});

test('it places agent-reviewing tasks in the AGENTS section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'review' });
  emit({
    type: 'agentStarted',
    agentType: 'reviewer',
    issueNumber: 1,
    sessionID: 'sess-r-1',
  });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('AGENTS (1)');
  });
});

// ---------------------------------------------------------------------------
// Overflow Indicator
// ---------------------------------------------------------------------------

test('it shows overflow indicator when items exceed capacity', async () => {
  const { lastFrame, emit } = setupTest({ paneHeight: 4 });
  // With paneHeight 4: ACTION gets ceil(4/2)=2 rows, 1 header = 1 capacity
  // AGENTS gets floor(4/2)=2 rows, 1 header = 1 capacity

  addIssue(emit, 1, { status: 'pending', title: 'First', priority: 'priority:high' });
  addIssue(emit, 2, { status: 'pending', title: 'Second', priority: 'priority:medium' });
  addIssue(emit, 3, { status: 'pending', title: 'Third', priority: 'priority:low' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    // ACTION should show (1/3) overflow
    expect(frame).toContain('ACTION (1/3)');
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

test('it sorts tasks by status weight within a section', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'pending', title: 'Ready', priority: 'priority:medium' });
  addIssue(emit, 2, { status: 'approved', title: 'Approved', priority: 'priority:medium' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const approvedPos = frame.indexOf('Approved');
    const readyPos = frame.indexOf('Ready');
    expect(approvedPos).toBeLessThan(readyPos);
  });
});

test('it sorts tasks by priority within the same status weight', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 1, { status: 'pending', title: 'Low', priority: 'priority:low' });
  addIssue(emit, 2, { status: 'pending', title: 'High', priority: 'priority:high' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const highPos = frame.indexOf('High');
    const lowPos = frame.indexOf('Low');
    expect(highPos).toBeLessThan(lowPos);
  });
});

test('it sorts tasks by issue number within the same priority', async () => {
  const { lastFrame, emit } = setupTest();

  addIssue(emit, 10, { status: 'pending', title: 'Higher', priority: 'priority:medium' });
  addIssue(emit, 5, { status: 'pending', title: 'Lower', priority: 'priority:medium' });

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    const lowerPos = frame.indexOf('Lower');
    const higherPos = frame.indexOf('Higher');
    expect(lowerPos).toBeLessThan(higherPos);
  });
});

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

test('it returns the worst CI status from a set of PRs', () => {
  expect(getWorstCIStatus([{ ciStatus: 'success' }, { ciStatus: 'failure' }])).toBe('failure');
  expect(getWorstCIStatus([{ ciStatus: 'success' }, { ciStatus: 'pending' }])).toBe('pending');
  expect(getWorstCIStatus([{ ciStatus: 'success' }])).toBe('success');
  expect(getWorstCIStatus([{ ciStatus: null }])).toBe(null);
});

test('it returns the correct CI status color', () => {
  expect(getCIStatusColor('failure')).toBe('red');
  expect(getCIStatusColor('pending')).toBe('dim');
  expect(getCIStatusColor('success')).toBe('green');
  expect(getCIStatusColor(null)).toBe('dim');
});

test('it returns the correct priority color', () => {
  expect(getIssuePriorityColor('high')).toBe('red');
  expect(getIssuePriorityColor('medium')).toBe('yellow');
  expect(getIssuePriorityColor('low')).toBe('dim');
  expect(getIssuePriorityColor(null)).toBeUndefined();
});

test('it computes section capacities correctly for even pane height', () => {
  const result = computeSectionCapacities(20);
  // ceil(20/2) = 10, floor(20/2) = 10
  // Each minus 1 for header
  expect(result.actionCapacity).toBe(9);
  expect(result.agentsCapacity).toBe(9);
});

test('it gives the extra row to ACTION when pane height is odd', () => {
  const result = computeSectionCapacities(21);
  // ceil(21/2) = 11 - 1 = 10
  // floor(21/2) = 10 - 1 = 9
  expect(result.actionCapacity).toBe(10);
  expect(result.agentsCapacity).toBe(9);
});

test('it computes visible tasks respecting section capacities', () => {
  const sortedTasks = [
    { task: { issueNumber: 1 }, section: 'action' as const },
    { task: { issueNumber: 2 }, section: 'action' as const },
    { task: { issueNumber: 3 }, section: 'action' as const },
    { task: { issueNumber: 4 }, section: 'agents' as const },
    { task: { issueNumber: 5 }, section: 'agents' as const },
  ];

  // biome-ignore lint/suspicious/noExplicitAny: test utility with partial task objects
  const result = getVisibleTasks(sortedTasks as any, 2, 1);
  expect(result).toHaveLength(3);
  expect(result[0]?.task.issueNumber).toBe(1);
  expect(result[1]?.task.issueNumber).toBe(2);
  expect(result[2]?.task.issueNumber).toBe(4);
});

// ---------------------------------------------------------------------------
// Selection highlight
// ---------------------------------------------------------------------------

test('it highlights the selected task row', async () => {
  const { lastFrame, emit, store } = setupTest();

  addIssue(emit, 1, { title: 'Selected task' });
  store.getState().selectIssue(1);

  await vi.waitFor(() => {
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Selected task');
  });
});
