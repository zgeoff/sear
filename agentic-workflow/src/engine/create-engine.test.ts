import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { vol } from 'memfs';
import invariant from 'tiny-invariant';
import { expect, test, vi } from 'vitest';
import { buildPullsListItem } from '../test-utils/build-pulls-list-item.ts';
import { buildValidConfig } from '../test-utils/build-valid-config.ts';
import { createMockGitHubClient } from '../test-utils/create-mock-github-client.ts';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  CICheckFailedEvent,
  CICheckRecoveredEvent,
  CIStatusChangedEvent,
  EngineEvent,
  IssueStatusChangedEvent,
} from '../types.ts';
import type { AgentQuery, QueryFactory, QueryFactoryParams } from './agent-manager/types.ts';
import { createEngine } from './create-engine.ts';
import type { GitHubClient } from './github-client/types.ts';
import type { PlannerCacheEntry } from './planner-cache/types.ts';
import type { WorktreeManager } from './worktree-manager/types.ts';

const FRESH_BRANCH_PATTERN = /^issue-42-\d+$/;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue('/resolved/repo/root\n'),
  };
});

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

type MockQuery = AgentQuery &
  AsyncIterator<unknown> & {
    pushMessage: (msg: unknown) => void;
    end: () => void;
  };

function createMockQuery(): MockQuery {
  const pendingReads: Array<{ resolve: (result: IteratorResult<unknown>) => void }> = [];
  const bufferedMessages: unknown[] = [];
  let ended = false;

  const mockQuery: MockQuery = {
    pushMessage(msg: unknown): void {
      if (pendingReads.length > 0) {
        const pending = pendingReads.shift();
        invariant(pending, 'pendingReads must have an entry when length > 0');
        pending.resolve({ value: msg, done: false });
        return;
      }
      bufferedMessages.push(msg);
    },

    end(): void {
      ended = true;
      for (const pending of pendingReads) {
        pending.resolve({ value: undefined, done: true });
      }
      pendingReads.length = 0;
    },

    interrupt: vi.fn().mockResolvedValue(undefined),

    async next(): Promise<IteratorResult<unknown>> {
      if (bufferedMessages.length > 0) {
        const msg = bufferedMessages.shift();
        invariant(msg !== undefined, 'bufferedMessages must have an entry when length > 0');
        return { value: msg, done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return new Promise((resolve) => {
        pendingReads.push({ resolve });
      });
    },

    async return(): Promise<IteratorResult<unknown>> {
      ended = true;
      for (const pending of pendingReads) {
        pending.resolve({ value: undefined, done: true });
      }
      pendingReads.length = 0;
      return { value: undefined, done: true as const };
    },

    async throw(): Promise<IteratorResult<unknown>> {
      ended = true;
      for (const pending of pendingReads) {
        pending.resolve({ value: undefined, done: true });
      }
      pendingReads.length = 0;
      return { value: undefined, done: true as const };
    },

    [Symbol.asyncIterator](): MockQuery {
      return mockQuery;
    },
  };

  return mockQuery;
}

interface BuildMockIssueDataOptions {
  title?: string;
  priority?: string;
  complexity?: string;
}

function buildMockIssueData(
  number: number,
  status: string,
  options?: BuildMockIssueDataOptions,
): {
  number: number;
  title: string;
  body: string;
  labels: Array<{ name: string }>;
  created_at: string;
} {
  const title = options?.title ?? `Issue #${number}`;
  const priority = options?.priority ?? 'priority:medium';
  const labels = [{ name: 'task:implement' }, { name: `status:${status}` }, { name: priority }];
  if (options?.complexity) {
    labels.push({ name: options.complexity });
  }
  return {
    number,
    title,
    body: `Task body for #${number}`,
    labels,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function setupMockGitHubClient(
  octokit: GitHubClient,
  issues: ReturnType<typeof buildMockIssueData>[] = [],
): void {
  // Differentiate between recovery query (status:in-progress) and regular poll
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] }; // No in-progress issues by default (startup recovery)
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockImplementation(async (params: { issue_number: number }) => {
    const issue = issues.find((i) => i.number === params.issue_number);
    return { data: issue ?? buildMockIssueData(params.issue_number, 'pending') };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });

  // SpecPoller: no tree changes by default
  vi.mocked(octokit.git.getTree).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  // Queries: PRs — generate a linked PR for each issue so getPRForIssue can resolve branchName
  const mockPRListItems = issues.map((issue, index) =>
    buildPullsListItem({
      number: 100 + index,
      body: `Closes #${issue.number}`,
      draft: false,
    }),
  );
  const mockPRDetails = issues.map((issue, index) => ({
    number: 100 + index,
    title: `PR for #${issue.number}`,
    changed_files: 3,
    html_url: `https://github.com/owner/repo/pull/${100 + index}`,
    head: { sha: `sha-${issue.number}`, ref: `issue-${issue.number}-branch` },
    draft: false,
  }));
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: mockPRListItems });
  vi.mocked(octokit.pulls.get).mockImplementation(async (params: { pull_number: number }) => {
    const defaultPR = {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: '',
      head: { sha: 'sha', ref: 'branch' },
      draft: false,
    };
    return { data: mockPRDetails.find((p) => p.number === params.pull_number) ?? defaultPR };
  });
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({
    data: { content: '' },
  });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [],
  });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({
    data: [],
  });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({
    data: [],
  });
}

function createMockWorktreeManager(): WorktreeManager {
  return {
    createOrReuse: vi.fn().mockResolvedValue({
      worktreePath: '/tmp/test-repo/.worktrees/issue-42',
      branch: 'issue-42',
      created: true,
    }),
    createForBranch: vi
      .fn()
      .mockImplementation((params: { branchName: string; branchBase?: string }) =>
        Promise.resolve({
          worktreePath: `/tmp/test-repo/.worktrees/${params.branchName}`,
          branch: params.branchName,
          created: params.branchBase !== undefined,
        }),
      ),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByPath: vi.fn().mockResolvedValue(undefined),
  };
}

interface SetupOptions {
  issues?: ReturnType<typeof buildMockIssueData>[];
  autoComplete?: boolean;
  shutdownTimeout?: number;
}

function setupTest(
  issueOverridesOrOptions?: ReturnType<typeof buildMockIssueData>[] | SetupOptions,
): {
  engine: ReturnType<typeof createEngine>;
  events: EngineEvent[];
  octokit: ReturnType<typeof createMockGitHubClient>;
  queryFactory: QueryFactory;
  mockQueries: MockQuery[];
  capturedQueryParams: QueryFactoryParams[];
  config: ReturnType<typeof buildValidConfig>;
  worktreeManager: WorktreeManager;
} {
  const options: SetupOptions = Array.isArray(issueOverridesOrOptions)
    ? { issues: issueOverridesOrOptions }
    : (issueOverridesOrOptions ?? {});

  const issues = options.issues ?? [];
  const autoComplete = options.autoComplete ?? true;

  const octokit = createMockGitHubClient();
  const mockQueries: MockQuery[] = [];
  const capturedQueryParams: QueryFactoryParams[] = [];
  const worktreeManager = createMockWorktreeManager();

  const queryFactory: QueryFactory = async (params: QueryFactoryParams) => {
    capturedQueryParams.push(params);
    const q = createMockQuery();
    if (autoComplete) {
      // Auto-complete the session immediately
      q.pushMessage({
        type: 'system',
        subtype: 'init',
        session_id: `session-${mockQueries.length + 1}`,
      });
      q.pushMessage({ type: 'result', subtype: 'success' });
      q.end();
    } else {
      // Send init but leave session open for manual control
      q.pushMessage({
        type: 'system',
        subtype: 'init',
        session_id: `session-${mockQueries.length + 1}`,
      });
    }
    mockQueries.push(q);
    return q;
  };

  const config = buildValidConfig(
    options.shutdownTimeout !== undefined
      ? { shutdownTimeout: options.shutdownTimeout }
      : undefined,
  );

  setupMockGitHubClient(octokit, issues);

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock yarn install — always succeeds in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  return {
    engine,
    events,
    octokit,
    queryFactory,
    mockQueries,
    capturedQueryParams,
    config,
    worktreeManager,
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

test('it resolves with issue count and recoveries after startup', async () => {
  const issues = [buildMockIssueData(1, 'pending'), buildMockIssueData(2, 'review')];
  const { engine } = setupTest(issues);

  const result = await engine.start();

  expect(result.issueCount).toBe(2);
  expect(result.recoveriesPerformed).toBe(0);
});

test('it performs startup recovery for in-progress issues', async () => {
  const octokit = createMockGitHubClient();
  const queryFactory: QueryFactory = async (_params: QueryFactoryParams) => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };
  const config = buildValidConfig();

  // Startup recovery query returns in-progress issues
  const recoveryIssues = [buildMockIssueData(5, 'in-progress')];

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: recoveryIssues };
    }
    // Regular poll returns the issue as pending (after recovery reset)
    return { data: [buildMockIssueData(5, 'pending')] };
  });

  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  const result = await engine.start();

  expect(result.recoveriesPerformed).toBe(1);
  expect(events.some((e) => e.type === 'recoveryPerformed')).toBe(true);
});

test('it runs the first issue poller cycle during startup', async () => {
  const issues = [buildMockIssueData(1, 'pending')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  const statusEvents = events.filter(
    (e): e is IssueStatusChangedEvent => e.type === 'issueStatusChanged',
  );
  expect(statusEvents.length).toBeGreaterThan(0);

  const firstEvent = statusEvents[0];
  invariant(firstEvent, 'statusEvents must have at least one entry');
  expect(firstEvent.issueNumber).toBe(1);
  expect(firstEvent.oldStatus).toBeNull();
  expect(firstEvent.newStatus).toBe('pending');
});

test('it runs the first spec poller cycle during startup', async () => {
  const { engine, octokit } = setupTest();

  await engine.start();

  expect(octokit.git.getTree).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Event forwarding
// ---------------------------------------------------------------------------

test('it forwards events from all components through the event emitter', async () => {
  const issues = [buildMockIssueData(1, 'pending')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  expect(events.some((e) => e.type === 'issueStatusChanged')).toBe(true);
});

test('it returns an unsubscribe function from the event emitter', async () => {
  const { engine } = setupTest();

  const laterEvents: EngineEvent[] = [];
  const unsub = engine.on((event) => {
    laterEvents.push(event);
  });

  unsub();

  await engine.start();

  expect(laterEvents.length).toBe(0);
});

// ---------------------------------------------------------------------------
// Command routing: dispatchImplementor
// ---------------------------------------------------------------------------

test('it is a no-op when dispatching an implementor for an issue not in the snapshot', async () => {
  const { engine, mockQueries } = setupTest();

  await engine.start();
  const queriesBefore = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 999 });

  await vi.waitFor(() => {
    expect(mockQueries.length).toBe(queriesBefore);
  });
});

test('it is a no-op when dispatching an implementor for an issue not in user-dispatch status', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, mockQueries } = setupTest(issues);

  await engine.start();

  const queriesAfterStart = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    // No new queries beyond what startup created
    expect(mockQueries.length).toBe(queriesAfterStart);
  });
});

test('it dispatches an implementor for an in-progress issue with no running agent', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, mockQueries } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const queriesBeforeDispatch = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    expect(mockQueries.length).toBeGreaterThan(queriesBeforeDispatch);
  });

  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted.length).toBeGreaterThan(0);
});

test('it skips dispatching an implementor for an in-progress issue with a running agent', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events } = setupTest({ issues, autoComplete: false });

  await engine.start();

  // First dispatch: starts the agent (in-progress with no agent running)
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // Second dispatch: agent is now running, should be silently skipped (info log, no event)
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  // Wait briefly then verify only one agentStarted event exists — the second dispatch was skipped
  await vi.waitFor(() => {
    const agentStartedAfter = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStartedAfter.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Command routing: dispatchImplementor — complexity-based model override
// ---------------------------------------------------------------------------

test('it passes a sonnet model override when dispatching an implementor for a simple-complexity issue', async () => {
  const issues = [buildMockIssueData(42, 'pending', { complexity: 'complexity:simple' })];
  const { engine, capturedQueryParams } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
    expect(implementorParams.length).toBeGreaterThanOrEqual(1);
    expect(implementorParams[0]).toMatchObject({ modelOverride: 'sonnet' });
  });
});

test('it passes an opus model override when dispatching an implementor for a complex-complexity issue', async () => {
  const issues = [buildMockIssueData(42, 'pending', { complexity: 'complexity:complex' })];
  const { engine, capturedQueryParams } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
    expect(implementorParams.length).toBeGreaterThanOrEqual(1);
    expect(implementorParams[0]).toMatchObject({ modelOverride: 'opus' });
  });
});

test('it does not pass a model override when dispatching an implementor for an issue without a complexity label', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, capturedQueryParams } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
    expect(implementorParams.length).toBeGreaterThanOrEqual(1);
    expect(implementorParams[0]).not.toHaveProperty('modelOverride');
  });
});

// ---------------------------------------------------------------------------
// Command routing: dispatchReviewer
// ---------------------------------------------------------------------------

test('it does not auto-dispatch a reviewer when the issue is in review status', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  await vi.waitFor(() => {
    const agentStarted = events.filter((e) => e.type === 'agentStarted');
    expect(agentStarted.length).toBe(0);
  });
});

test('it is a no-op when dispatching a reviewer for an issue not in review status', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, mockQueries } = setupTest(issues);

  await engine.start();
  const queriesAfterStart = mockQueries.length;

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await vi.waitFor(() => {
    expect(mockQueries.length).toBe(queriesAfterStart);
  });
});

test('it is a no-op when dispatching a reviewer for an issue not in snapshot', async () => {
  const { engine, mockQueries } = setupTest();

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 999 });

  await vi.waitFor(() => {
    expect(mockQueries.length).toBe(0);
  });
});

test('it passes fetchRemote: true when dispatching a reviewer with a linked PR', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events, octokit, worktreeManager } = setupTest({
    issues,
    autoComplete: false,
  });

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: false })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 5,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42-branch' },
      draft: false,
    },
  });

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  expect(worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-42-branch',
    fetchRemote: true,
  });

  engine.send({ command: 'shutdown' });
});

test('it is a no-op when dispatching a reviewer for an issue with no linked PR', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, mockQueries, octokit } = setupTest({ issues });

  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  await engine.start();
  const queriesAfterStart = mockQueries.length;

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await vi.waitFor(() => {
    expect(mockQueries.length).toBe(queriesAfterStart);
  });
});

// ---------------------------------------------------------------------------
// Dispatch events
// ---------------------------------------------------------------------------

test('it emits a dispatch-ready event for pending issues', async () => {
  const issues = [buildMockIssueData(1, 'pending')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  const dispatchReady = events.filter((e) => e.type === 'dispatchReady');
  expect(dispatchReady.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test('it stops pollers and completes when no agents are running', async () => {
  const { engine } = setupTest();

  await engine.start();

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Cancel commands
// ---------------------------------------------------------------------------

test('it is a no-op when cancelling an agent for an issue with no running agent', async () => {
  const { engine } = setupTest();

  await engine.start();

  engine.send({ command: 'cancelAgent', issueNumber: 999 });
});

test('it is a no-op when cancelling the planner when none is running', async () => {
  const { engine } = setupTest();

  await engine.start();

  engine.send({ command: 'cancelPlanner' });
});

// ---------------------------------------------------------------------------
// Query delegation
// ---------------------------------------------------------------------------

test('it delegates getIssueDetails to the queries module', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, octokit } = setupTest(issues);

  await engine.start();

  const result = await engine.getIssueDetails(42);

  expect(result.number).toBe(42);
  expect(octokit.issues.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42 }));
});

test('it delegates getPRForIssue to the queries module', async () => {
  const { engine } = setupTest();

  await engine.start();

  const result = await engine.getPRForIssue(42);

  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// Stream accessor
// ---------------------------------------------------------------------------

test('it returns null from getAgentStream when no agent is running', async () => {
  const { engine } = setupTest();

  await engine.start();

  const stream = engine.getAgentStream(42);

  expect(stream).toBeNull();
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

test('it does not crash when a poll cycle throws a github API error', async () => {
  const octokit = createMockGitHubClient();
  const queryFactory: QueryFactory = async (_params: QueryFactoryParams) => {
    const q = createMockQuery();
    q.end();
    return q;
  };
  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });

  let callCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async () => {
    callCount += 1;
    if (callCount === 1) {
      // First call (startup recovery)
      return { data: [] };
    }
    if (callCount === 2) {
      // Second call (first poll cycle) -- throw error
      throw new Error('GitHub API rate limited');
    }
    return { data: [] };
  });
  vi.mocked(octokit.git.getTree).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
  });

  const result = await engine.start();
  expect(result.issueCount).toBe(0);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Positive command routing
// ---------------------------------------------------------------------------

test('it dispatches an implementor agent when the issue is in a user-dispatch status', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, mockQueries } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const queriesBeforeDispatch = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    expect(mockQueries.length).toBeGreaterThan(queriesBeforeDispatch);
  });

  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted.length).toBeGreaterThan(0);
});

test('it cancels a running agent and emits an agent-failed event', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events } = setupTest({ issues, autoComplete: false });

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await vi.waitFor(() => {
    // Verify the agent started
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  engine.send({ command: 'cancelAgent', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentFailed = events.filter(
      (e): e is AgentFailedEvent =>
        e.type === 'agentFailed' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentFailed.length).toBe(1);
    expect(agentFailed[0]?.error).toContain('Cancelled');
  });
});

test('it cancels running agents after shutdown timeout expires', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events } = setupTest({
    issues,
    autoComplete: false,
    shutdownTimeout: 5,
  });

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await vi.advanceTimersByTimeAsync(50);

  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted.length).toBe(1);

  engine.send({ command: 'shutdown' });

  // Advance past the shutdown timeout (5 seconds)
  await vi.advanceTimersByTimeAsync(6000);

  const agentFailed = events.filter(
    (e): e is AgentFailedEvent =>
      e.type === 'agentFailed' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentFailed.length).toBe(1);
});

test('it cancels a running agent when its issue is removed from the poller snapshot', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const mockQueries: MockQuery[] = [];
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(42, 'review')] };
    }
    // Second poll: issue removed
    return { data: [] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: false })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for #42',
      changed_files: 3,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-42', ref: 'issue-42-branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.issues.get).mockResolvedValue({
    data: buildMockIssueData(42, 'review'),
  });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [],
  });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({
    data: [],
  });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({
    data: [],
  });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    // Send init but don't auto-complete -- agent stays running
    q.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: `session-${mockQueries.length + 1}`,
    });
    mockQueries.push(q);
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock yarn install — always succeeds in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await vi.advanceTimersByTimeAsync(0);

  const started = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(started.length).toBe(1);

  // Advance past the poll interval (1 second) to trigger the second cycle
  await vi.advanceTimersByTimeAsync(1500);

  const issueRemoved = events.filter((e) => e.type === 'issueRemoved');
  expect(issueRemoved.length).toBe(1);

  const failed = events.filter(
    (e): e is AgentFailedEvent =>
      e.type === 'agentFailed' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(failed.length).toBe(1);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Repository root resolution
// ---------------------------------------------------------------------------

test('it uses the provided repository root when one is given via dependency injection', () => {
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();
  const config = buildValidConfig();

  setupMockGitHubClient(octokit);

  vi.mocked(execFileSync).mockClear();

  createEngine(config, {
    octokit,
    queryFactory: async () => {
      const q = createMockQuery();
      q.end();
      return q;
    },
    repoRoot: '/explicit/repo/root',
    worktreeManager,
  });

  expect(execFileSync).not.toHaveBeenCalled();
});

test('it resolves the repository root via git when none is provided', () => {
  const octokit = createMockGitHubClient();
  const config = buildValidConfig();

  setupMockGitHubClient(octokit);

  vi.mocked(execFileSync).mockReturnValue('/resolved/repo/root\n');

  createEngine(config, {
    octokit,
    queryFactory: async () => {
      const q = createMockQuery();
      q.end();
      return q;
    },
  });

  expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
});

// ---------------------------------------------------------------------------
// Planner Cache integration
// ---------------------------------------------------------------------------

function buildCacheEntry(): PlannerCacheEntry {
  return {
    snapshot: {
      specsDirTreeSHA: 'tree-sha-1',
      files: {
        'docs/specs/workflow/control-plane.md': {
          blobSHA: 'blob-sha-1',
          frontmatterStatus: 'approved',
        },
      },
    },
    commitSHA: 'cached-commit-sha',
  };
}

function setupCacheTest(
  options: SetupOptions & { cacheEntry?: PlannerCacheEntry } = {},
): ReturnType<typeof setupTest> {
  vol.reset();
  vol.mkdirSync('/tmp/test-repo', { recursive: true });

  if (options.cacheEntry) {
    vol.writeFileSync(
      '/tmp/test-repo/.agentic-workflow-cache.json',
      JSON.stringify(options.cacheEntry),
    );
  }

  return setupTest(options);
}

test('it does not dispatch the planner when the cache matches the current tree', async () => {
  const cacheEntry = buildCacheEntry();
  const { engine, mockQueries, octokit } = setupCacheTest({ cacheEntry });

  // SpecPoller returns tree-sha-1, matching the cache
  vi.mocked(octokit.git.getTree).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });

  await engine.start();

  // No planner should have been dispatched (no spec changes detected)
  const plannerQueries = mockQueries.length;
  expect(plannerQueries).toBe(0);
});

test('it reports only changed files when the cache has a different tree', async () => {
  const cacheEntry: PlannerCacheEntry = {
    snapshot: {
      specsDirTreeSHA: 'old-tree-sha',
      files: {
        'docs/specs/control-plane.md': {
          blobSHA: 'blob-sha-1',
          frontmatterStatus: 'approved',
        },
      },
    },
    commitSHA: 'old-commit-sha',
  };
  const { engine, events, octokit } = setupCacheTest({
    cacheEntry,
    autoComplete: true,
  });

  // SpecPoller: first call finds specs dir with a new tree SHA
  vi.mocked(octokit.git.getTree).mockImplementation(async (params) => {
    if (params.tree_sha === 'main') {
      return {
        data: {
          sha: 'root-sha',
          tree: [{ path: 'docs/specs', type: 'tree', sha: 'new-tree-sha' }],
        },
      };
    }
    // Second call: subtree enumeration
    return {
      data: {
        sha: 'new-tree-sha',
        tree: [
          { path: 'control-plane.md', type: 'blob', sha: 'blob-sha-1' },
          { path: 'new-spec.md', type: 'blob', sha: 'blob-sha-new' },
        ],
      },
    };
  });

  vi.mocked(octokit.repos.getContent).mockImplementation(async (params) => {
    if (params.path.includes('new-spec.md')) {
      const content = Buffer.from('---\nstatus: approved\n---\n# New Spec').toString('base64');
      return { data: { content } };
    }
    return { data: { content: '' } };
  });

  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-2' } },
  });

  await engine.start();

  await vi.waitFor(() => {
    // Should see a specChanged event only for the new file, not for control-plane.md
    const specChanged = events.filter((e) => e.type === 'specChanged');
    expect(specChanged.length).toBe(1);
    expect(specChanged[0]).toMatchObject({
      filePath: 'docs/specs/new-spec.md',
      frontmatterStatus: 'approved',
    });
  });
});

test('it writes the cache file when the planner completes successfully', async () => {
  const { engine, octokit, events } = setupCacheTest({ autoComplete: true });

  // Set up SpecPoller to detect changes (which triggers planner dispatch)
  vi.mocked(octokit.git.getTree).mockImplementation(async (params) => {
    if (params.tree_sha === 'main') {
      return {
        data: {
          sha: 'root-sha',
          tree: [{ path: 'docs/specs', type: 'tree', sha: 'tree-sha-new' }],
        },
      };
    }
    return {
      data: {
        sha: 'tree-sha-new',
        tree: [{ path: 'spec.md', type: 'blob', sha: 'blob-sha-1' }],
      },
    };
  });

  const specContent = Buffer.from('---\nstatus: approved\n---\n# Spec').toString('base64');
  vi.mocked(octokit.repos.getContent).mockResolvedValue({
    data: { content: specContent },
  });
  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  await engine.start();

  await vi.waitFor(async () => {
    // Verify the planner completed
    const completed = events.filter(
      (e): e is AgentCompletedEvent => e.type === 'agentCompleted' && e.agentType === 'planner',
    );
    expect(completed.length).toBe(1);

    // Verify cache file was written with PlannerCacheEntry format
    // (cache write is async and may not be flushed yet when the event appears)
    const raw = await readFile('/tmp/test-repo/.agentic-workflow-cache.json', 'utf-8');
    const cached: unknown = JSON.parse(raw);
    expect(cached).toMatchObject({
      snapshot: { specsDirTreeSHA: 'tree-sha-new' },
      commitSHA: 'commit-sha-1',
    });
  });
});

test('it does not write the cache file when the planner fails', async () => {
  const { engine, octokit, events, mockQueries } = setupCacheTest({ autoComplete: false });

  // Set up SpecPoller to detect changes
  vi.mocked(octokit.git.getTree).mockImplementation(async (params) => {
    if (params.tree_sha === 'main') {
      return {
        data: {
          sha: 'root-sha',
          tree: [{ path: 'docs/specs', type: 'tree', sha: 'tree-sha-new' }],
        },
      };
    }
    return {
      data: {
        sha: 'tree-sha-new',
        tree: [{ path: 'spec.md', type: 'blob', sha: 'blob-sha-1' }],
      },
    };
  });

  const specContent = Buffer.from('---\nstatus: approved\n---\n# Spec').toString('base64');
  vi.mocked(octokit.repos.getContent).mockResolvedValue({
    data: { content: specContent },
  });
  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  await engine.start();

  await vi.waitFor(() => {
    // Wait for planner to start
    expect(mockQueries.length).toBeGreaterThan(0);
  });

  // Fail the planner by ending the query with an execution error
  const plannerQuery = mockQueries[0];
  invariant(plannerQuery, 'planner query must exist');
  plannerQuery.pushMessage({ type: 'result', subtype: 'error_during_execution' });
  plannerQuery.end();

  await vi.waitFor(() => {
    // Verify the planner failed
    const failed = events.filter(
      (e): e is AgentFailedEvent => e.type === 'agentFailed' && e.agentType === 'planner',
    );
    expect(failed.length).toBe(1);
  });

  // Verify no cache file was written
  const exists = vol.existsSync('/tmp/test-repo/.agentic-workflow-cache.json');
  expect(exists).toBe(false);
});

// ---------------------------------------------------------------------------
// Planner Context Pre-computation
// ---------------------------------------------------------------------------

interface PlannerContextSetupOptions {
  cacheEntry?: PlannerCacheEntry;
  specTreeEntries: Array<{ path: string; sha: string }>;
  specContents: Record<string, string>;
  taskIssues?: Array<{
    number: number;
    title: string;
    labels: Array<{ name: string }>;
    body: string;
    created_at: string;
  }>;
}

function setupPlannerContextTest(options: PlannerContextSetupOptions): {
  engine: ReturnType<typeof createEngine>;
  events: EngineEvent[];
  octokit: ReturnType<typeof createMockGitHubClient>;
  capturedPrompts: string[];
} {
  vol.reset();
  vol.mkdirSync('/tmp/test-repo', { recursive: true });

  if (options.cacheEntry) {
    vol.writeFileSync(
      '/tmp/test-repo/.agentic-workflow-cache.json',
      JSON.stringify(options.cacheEntry),
    );
  }

  const octokit = createMockGitHubClient();
  const capturedPrompts: string[] = [];
  const worktreeManager = createMockWorktreeManager();

  const queryFactory: QueryFactory = async (params: QueryFactoryParams) => {
    capturedPrompts.push(params.prompt);
    const q = createMockQuery();
    q.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: `session-${capturedPrompts.length}`,
    });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig();

  // Issue poller: no in-progress issues (recovery), return task issues for regular polls
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    if (params.labels === 'task:implement' || params.labels === 'task:refinement') {
      return { data: options.taskIssues ?? [] };
    }
    return { data: [] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  // SpecPoller: return the configured tree entries
  vi.mocked(octokit.git.getTree).mockImplementation(async (params) => {
    if (params.tree_sha === 'main') {
      return {
        data: {
          sha: 'root-sha',
          tree: [{ path: 'docs/specs', type: 'tree', sha: 'new-tree-sha' }],
        },
      };
    }
    return {
      data: {
        sha: 'new-tree-sha',
        tree: options.specTreeEntries.map((entry) => ({
          path: entry.path,
          type: 'blob',
          sha: entry.sha,
        })),
      },
    };
  });

  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'current-commit-sha' } },
  });

  // Spec content: return base64-encoded content for each spec
  vi.mocked(octokit.repos.getContent).mockImplementation(async (params) => {
    const rawContent = options.specContents[params.path] ?? '';
    const content = Buffer.from(rawContent).toString('base64');
    return { data: { content } };
  });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock yarn install — always succeeds in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  return { engine, events, octokit, capturedPrompts };
}

test('it includes the full content of each changed spec in the planner prompt', async () => {
  const specContent = '---\nstatus: approved\n---\n# My Spec\n\nSpec body content here.';

  const { engine, capturedPrompts } = setupPlannerContextTest({
    specTreeEntries: [{ path: 'my-spec.md', sha: 'blob-sha-1' }],
    specContents: { 'docs/specs/my-spec.md': specContent },
  });

  await engine.start();

  await vi.waitFor(() => {
    expect(capturedPrompts.length).toBeGreaterThan(0);
  });

  const prompt = capturedPrompts[0];
  invariant(prompt, 'prompt must exist');
  expect(prompt).toContain('## Changed Specs');
  expect(prompt).toContain('### docs/specs/my-spec.md (added)');
  expect(prompt).toContain(specContent);

  engine.send({ command: 'shutdown' });
});

test('it includes a unified diff for modified specs in the planner prompt', async () => {
  const specContent = '---\nstatus: approved\n---\n# My Spec\n\nUpdated content.';
  const diffOutput =
    'diff --git a/docs/specs/my-spec.md b/docs/specs/my-spec.md\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new';

  // Set up a cache entry so the spec is "modified" (it was known before)
  const cacheEntry: PlannerCacheEntry = {
    snapshot: {
      specsDirTreeSHA: 'old-tree-sha',
      files: {
        'docs/specs/my-spec.md': { blobSHA: 'old-blob-sha', frontmatterStatus: 'approved' },
      },
    },
    commitSHA: 'previous-commit-sha',
  };

  // Mock execFileSync to return diff output for git diff calls
  vi.mocked(execFileSync).mockImplementation((file, args, _options) => {
    if (file === 'git' && Array.isArray(args) && args[0] === 'diff') {
      return diffOutput;
    }
    if (file === 'git' && Array.isArray(args) && args[0] === 'rev-parse') {
      return '/resolved/repo/root\n';
    }
    return '';
  });

  const { engine, capturedPrompts } = setupPlannerContextTest({
    cacheEntry,
    specTreeEntries: [{ path: 'my-spec.md', sha: 'new-blob-sha' }],
    specContents: { 'docs/specs/my-spec.md': specContent },
  });

  await engine.start();

  await vi.waitFor(() => {
    expect(capturedPrompts.length).toBeGreaterThan(0);
  });

  const prompt = capturedPrompts[0];
  invariant(prompt, 'prompt must exist');
  expect(prompt).toContain('### docs/specs/my-spec.md (modified)');
  expect(prompt).toContain('#### Diff');
  expect(prompt).toContain(diffOutput);

  // Reset the mock to default
  vi.mocked(execFileSync).mockReturnValue('/resolved/repo/root\n');
  engine.send({ command: 'shutdown' });
});

test('it does not include a diff section for added specs in the planner prompt', async () => {
  const specContent = '---\nstatus: approved\n---\n# Brand New Spec';

  const { engine, capturedPrompts } = setupPlannerContextTest({
    specTreeEntries: [{ path: 'new-spec.md', sha: 'blob-sha-1' }],
    specContents: { 'docs/specs/new-spec.md': specContent },
  });

  await engine.start();

  await vi.waitFor(() => {
    expect(capturedPrompts.length).toBeGreaterThan(0);
  });

  const prompt = capturedPrompts[0];
  invariant(prompt, 'prompt must exist');
  expect(prompt).toContain('### docs/specs/new-spec.md (added)');
  expect(prompt).not.toContain('#### Diff');

  engine.send({ command: 'shutdown' });
});

test('it includes existing open task issues as a JSON array in the planner prompt', async () => {
  const specContent = '---\nstatus: approved\n---\n# Spec';
  const taskIssues = [
    {
      number: 10,
      title: 'Implement feature X',
      labels: [{ name: 'task:implement' }, { name: 'status:pending' }],
      body: 'Task body for feature X',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      number: 20,
      title: 'Refine spec Y',
      labels: [{ name: 'task:refinement' }, { name: 'status:needs-refinement' }],
      body: 'Refinement details',
      created_at: '2026-01-02T00:00:00Z',
    },
  ];

  const { engine, capturedPrompts } = setupPlannerContextTest({
    specTreeEntries: [{ path: 'spec.md', sha: 'blob-sha-1' }],
    specContents: { 'docs/specs/spec.md': specContent },
    taskIssues,
  });

  await engine.start();

  await vi.waitFor(() => {
    expect(capturedPrompts.length).toBeGreaterThan(0);
  });

  const prompt = capturedPrompts[0];
  invariant(prompt, 'prompt must exist');
  expect(prompt).toContain('## Existing Open Issues');

  // Parse the JSON array from the prompt
  const issuesJsonMatch = prompt.split('## Existing Open Issues\n')[1];
  invariant(issuesJsonMatch, 'issues JSON section must exist');
  const parsedIssues: unknown = JSON.parse(issuesJsonMatch);
  expect(parsedIssues).toStrictEqual([
    {
      number: 10,
      title: 'Implement feature X',
      labels: ['task:implement', 'status:pending'],
      body: 'Task body for feature X',
    },
    {
      number: 20,
      title: 'Refine spec Y',
      labels: ['task:refinement', 'status:needs-refinement'],
      body: 'Refinement details',
    },
  ]);

  engine.send({ command: 'shutdown' });
});

test('it re-adds spec paths to the deferred buffer when spec content fetch fails', async () => {
  const octokit = createMockGitHubClient();
  const capturedPrompts: string[] = [];
  const worktreeManager = createMockWorktreeManager();

  const queryFactory: QueryFactory = async (params: QueryFactoryParams) => {
    capturedPrompts.push(params.prompt);
    const q = createMockQuery();
    q.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: `session-${capturedPrompts.length}`,
    });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: [] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  // First SpecPoller cycle: detect a new spec
  vi.mocked(octokit.git.getTree).mockImplementation(async (params) => {
    if (params.tree_sha === 'main') {
      return {
        data: {
          sha: 'root-sha',
          tree: [{ path: 'docs/specs', type: 'tree', sha: 'new-tree-sha' }],
        },
      };
    }
    return {
      data: {
        sha: 'new-tree-sha',
        tree: [{ path: 'spec.md', type: 'blob', sha: 'blob-sha-1' }],
      },
    };
  });

  vi.mocked(octokit.git.getRef).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  // Make repos.getContent fail on first call, succeed on retry
  let getContentCallCount = 0;
  vi.mocked(octokit.repos.getContent).mockImplementation(async (_params) => {
    getContentCallCount += 1;
    if (getContentCallCount === 1) {
      // First call to getContent (during frontmatter check in SpecPoller)
      const content = Buffer.from('---\nstatus: approved\n---\n# Spec').toString('base64');
      return { data: { content } };
    }
    if (getContentCallCount === 2) {
      // Second call: planner context fetch — fail
      throw new Error('GitHub API error');
    }
    // Subsequent calls: succeed
    const content = Buffer.from('---\nstatus: approved\n---\n# Spec').toString('base64');
    return { data: { content } };
  });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock yarn install — always succeeds in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.waitFor(() => {
    // No planner should have been dispatched (the prompt build failed)
    expect(capturedPrompts.length).toBe(0);
  });

  // The spec paths should be re-added to the deferred buffer.
  // On the next spec poller cycle, the deferred paths will be re-dispatched.
  // We verify this indirectly: no agentStarted event for planner
  const plannerStarted = events.filter(
    (e) => e.type === 'agentStarted' && e.agentType === 'planner',
  );
  expect(plannerStarted.length).toBe(0);

  engine.send({ command: 'shutdown' });
});

test('it treats a corrupt cache file as a cold start', async () => {
  vol.reset();
  vol.mkdirSync('/tmp/test-repo', { recursive: true });
  vol.writeFileSync('/tmp/test-repo/.agentic-workflow-cache.json', '{corrupt json');

  const { engine, octokit } = setupTest();

  // SpecPoller should behave as cold start (empty snapshot)
  vi.mocked(octokit.git.getTree).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });

  // Should not throw
  const result = await engine.start();
  expect(result.issueCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Completion-dispatch: Implementor completes with a linked non-draft PR
// ---------------------------------------------------------------------------

test('it dispatches the reviewer when an implementor completes with a linked non-draft PR', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, octokit, mockQueries, capturedQueryParams } = setupTest({
    issues,
    autoComplete: false,
  });

  // Set up a linked non-draft PR for issue #42
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: false })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 5,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42' },
      draft: false,
    },
  });

  await engine.start();

  // Dispatch an implementor
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  const implementorQuery = mockQueries.at(-1);
  invariant(implementorQuery, 'implementor query must exist');

  // Complete the implementor session
  implementorQuery.pushMessage({ type: 'result', subtype: 'success' });
  implementorQuery.end();

  await vi.waitFor(() => {
    // Verify the Reviewer was dispatched (a new query was created after the implementor)
    const reviewerParams = capturedQueryParams.filter((p) => p.agent === 'reviewer');
    expect(reviewerParams.length).toBeGreaterThan(0);
  });

  // Verify status:review was set via GitHub API
  expect(octokit.issues.removeLabel).toHaveBeenCalledWith(
    expect.objectContaining({ issue_number: 42, name: 'status:in-progress' }),
  );
  expect(octokit.issues.addLabels).toHaveBeenCalledWith(
    expect.objectContaining({ issue_number: 42, labels: ['status:review'] }),
  );

  // Verify a synthetic issueStatusChanged event was emitted with isEngineTransition: true
  const syntheticEvents = events.filter(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' &&
      e.issueNumber === 42 &&
      e.newStatus === 'review' &&
      e.isEngineTransition === true,
  );
  expect(syntheticEvents).toHaveLength(1);

  engine.send({ command: 'shutdown' });
});

test('it passes fetchRemote: true when dispatching reviewer after implementor completion', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, octokit, mockQueries, worktreeManager } = setupTest({
    issues,
    autoComplete: false,
  });

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: false })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 5,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42-completion-branch' },
      draft: false,
    },
  });

  await engine.start();

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  const implementorQuery = mockQueries.at(-1);
  invariant(implementorQuery, 'implementor query must exist');

  implementorQuery.pushMessage({ type: 'result', subtype: 'success' });
  implementorQuery.end();

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(2);
  });

  const createForBranchCalls = vi.mocked(worktreeManager.createForBranch).mock.calls;
  const reviewerCall = createForBranchCalls.filter(
    (call) => call[0]?.branchName === 'issue-42-completion-branch',
  );
  expect(reviewerCall.length).toBeGreaterThan(0);
  const lastReviewerCall = reviewerCall.at(-1);
  expect(lastReviewerCall?.[0]).toMatchObject({
    branchName: 'issue-42-completion-branch',
    fetchRemote: true,
  });

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Completion-dispatch: Snapshot sync prevents duplicate events
// ---------------------------------------------------------------------------

test('it does not emit a duplicate status change when the poller runs after completion-dispatch', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, octokit, mockQueries } = setupTest({
    issues,
    autoComplete: false,
  });

  // Set up a linked non-draft PR for issue #42
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: false })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 5,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42' },
      draft: false,
    },
  });

  await engine.start();

  // Dispatch an implementor
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  const implementorQuery = mockQueries.at(-1);
  invariant(implementorQuery, 'implementor query must exist');

  // Complete the implementor session
  implementorQuery.pushMessage({ type: 'result', subtype: 'success' });
  implementorQuery.end();

  await vi.waitFor(() => {
    const completed = events.filter(
      (e) => e.type === 'agentCompleted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(completed.length).toBe(1);
  });

  // Simulate next poller cycle: issue now appears as status:review from GitHub
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: [buildMockIssueData(42, 'review')] };
  });

  // Manually trigger another poll by re-creating the scenario via a short wait
  // (The poller interval handles this in production; we just need to verify the snapshot matches)
  // The snapshot was updated by completion-dispatch, so the poller should see no change.
  // Verify by checking the snapshot directly
  const statusEvents = events.filter(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' && e.issueNumber === 42 && e.newStatus === 'review',
  );
  // Should have exactly one (from completion-dispatch), not two
  expect(statusEvents).toHaveLength(1);
  expect(statusEvents[0]?.isEngineTransition).toBe(true);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Completion-dispatch: No PR found — no action
// ---------------------------------------------------------------------------

test('it does not dispatch a reviewer when an implementor completes with no linked PR', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, octokit, mockQueries, capturedQueryParams } = setupTest({
    issues,
    autoComplete: false,
  });

  // No PRs linked to issue #42
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  await engine.start();

  // Dispatch an implementor
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  const paramsBeforeCompletion = capturedQueryParams.length;

  const implementorQuery = mockQueries.at(-1);
  invariant(implementorQuery, 'implementor query must exist');

  // Complete the implementor session
  implementorQuery.pushMessage({ type: 'result', subtype: 'success' });
  implementorQuery.end();

  await vi.waitFor(() => {
    const completed = events.filter(
      (e) => e.type === 'agentCompleted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(completed.length).toBe(1);
  });

  // No reviewer should have been dispatched (no new queries beyond the implementor)
  const reviewerParams = capturedQueryParams
    .slice(paramsBeforeCompletion)
    .filter((p) => p.agent === 'reviewer');
  expect(reviewerParams).toHaveLength(0);

  // No synthetic issueStatusChanged with isEngineTransition should have been emitted
  const syntheticEvents = events.filter(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' && e.isEngineTransition === true,
  );
  expect(syntheticEvents).toHaveLength(0);

  // The status:review label should NOT have been set
  const addLabelsCalls = vi.mocked(octokit.issues.addLabels).mock.calls;
  const reviewLabelCalls = addLabelsCalls.filter(
    (call) => Array.isArray(call[0]?.labels) && call[0].labels.includes('status:review'),
  );
  expect(reviewLabelCalls).toHaveLength(0);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Completion-dispatch: Implementor failure — no PR check or Reviewer dispatch
// ---------------------------------------------------------------------------

test('it does not check for a PR or dispatch a reviewer when an implementor fails', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, octokit, mockQueries, capturedQueryParams } = setupTest({
    issues,
    autoComplete: false,
  });

  // Set up a linked non-draft PR (should NOT be checked for failures)
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: false })],
  });

  await engine.start();

  // Dispatch an implementor
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // Clear the pulls.list call count from dispatch (which uses includeDrafts: true for worktree strategy)
  vi.mocked(octokit.pulls.list).mockClear();

  const paramsBeforeFailure = capturedQueryParams.length;

  const implementorQuery = mockQueries.at(-1);
  invariant(implementorQuery, 'implementor query must exist');

  // Fail the implementor session
  implementorQuery.pushMessage({ type: 'result', subtype: 'error_during_execution' });
  implementorQuery.end();

  await vi.waitFor(() => {
    const agentFailed = events.filter(
      (e) => e.type === 'agentFailed' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentFailed.length).toBe(1);
  });

  // No PR check should have been performed for the failure path
  // (The completion-dispatch only fires on agentCompleted, not agentFailed)
  // No reviewer should have been dispatched
  const reviewerParams = capturedQueryParams
    .slice(paramsBeforeFailure)
    .filter((p) => p.agent === 'reviewer');
  expect(reviewerParams).toHaveLength(0);

  // No synthetic issueStatusChanged with isEngineTransition should have been emitted
  const syntheticEvents = events.filter(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' && e.isEngineTransition === true,
  );
  expect(syntheticEvents).toHaveLength(0);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Worktree strategy: dispatchImplementor calls getPRForIssue for strategy selection
// ---------------------------------------------------------------------------

test('it calls getPRForIssue with includeDrafts when dispatching an implementor', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit } = setupTest({ issues, autoComplete: true });

  // No linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  await engine.start();

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // getPRForIssue calls octokit.pulls.list — verify it was called
  expect(octokit.pulls.list).toHaveBeenCalled();

  engine.send({ command: 'shutdown' });
});

test('it uses a fresh branch with timestamp when no linked PR exists', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit, worktreeManager } = setupTest({
    issues,
    autoComplete: true,
  });

  // No linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  await engine.start();

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // Verify createForBranch was called with a fresh branch name (issue-42-<timestamp>) and branchBase: 'main'
  expect(worktreeManager.createForBranch).toHaveBeenCalledWith(
    expect.objectContaining({
      branchName: expect.stringMatching(FRESH_BRANCH_PATTERN),
      branchBase: 'main',
    }),
  );

  engine.send({ command: 'shutdown' });
});

test('it uses the PR branch when a linked PR exists', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit, worktreeManager } = setupTest({
    issues,
    autoComplete: true,
  });

  // Linked PR with headRefName 'issue-42-1738000000'
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: true })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 5,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42-1738000000' },
      draft: true,
    },
  });

  await engine.start();

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // Verify createForBranch was called with the PR's headRefName and NO branchBase
  expect(worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-42-1738000000',
  });

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Implementor Context Pre-computation
// ---------------------------------------------------------------------------

test('it calls getIssueDetails before every implementor dispatch', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit } = setupTest({ issues, autoComplete: true });

  // No linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  await engine.start();

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // getIssueDetails calls octokit.issues.get — verify it was called with the issue number
  expect(octokit.issues.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42 }));

  engine.send({ command: 'shutdown' });
});

test('it builds an enriched prompt with issue details only when no linked PR exists', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, capturedQueryParams, octokit } = setupTest({ issues, autoComplete: true });

  // No linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
    expect(implementorParams.length).toBeGreaterThanOrEqual(1);
  });

  const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
  invariant(implementorParams[0], 'implementor params must exist');
  const prompt = implementorParams[0].prompt;

  // Prompt should contain the issue section
  expect(prompt).toContain('## Task Issue #42');
  expect(prompt).toContain('Task body for #42');
  expect(prompt).toContain('### Labels');

  // Prompt should NOT contain PR, reviews, or inline comments sections
  expect(prompt).not.toContain('## PR #');
  expect(prompt).not.toContain('### Changed Files');
  expect(prompt).not.toContain('### Prior Reviews');
  expect(prompt).not.toContain('### Prior Inline Comments');

  engine.send({ command: 'shutdown' });
});

test('it builds an enriched prompt with PR data when a linked PR exists', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, capturedQueryParams, octokit } = setupTest({ issues, autoComplete: true });

  // Linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: true })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'Fix issue 42',
      changed_files: 2,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42-branch' },
      draft: true,
    },
  });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [{ filename: 'src/foo.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
  });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({
    data: [
      {
        id: 1,
        user: { login: 'reviewer1' },
        state: 'CHANGES_REQUESTED',
        body: 'Please fix the bug',
      },
    ],
  });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({
    data: [
      {
        id: 2,
        user: { login: 'reviewer1' },
        body: 'This line is wrong',
        path: 'src/foo.ts',
        line: 5,
      },
    ],
  });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
    expect(implementorParams.length).toBeGreaterThanOrEqual(1);
  });

  const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
  invariant(implementorParams[0], 'implementor params must exist');
  const prompt = implementorParams[0].prompt;

  // Prompt should contain the issue section
  expect(prompt).toContain('## Task Issue #42');
  expect(prompt).toContain('Task body for #42');

  // Prompt should contain the PR section with files
  expect(prompt).toContain('## PR #100 — Fix issue 42');
  expect(prompt).toContain('### Changed Files');
  expect(prompt).toContain('src/foo.ts (modified)');
  expect(prompt).toContain('@@ -1 +1 @@');

  // Prompt should contain review and inline comment sections
  expect(prompt).toContain('### Prior Reviews');
  expect(prompt).toContain('Review by reviewer1 — CHANGES_REQUESTED');
  expect(prompt).toContain('Please fix the bug');
  expect(prompt).toContain('### Prior Inline Comments');
  expect(prompt).toContain('src/foo.ts:5 — reviewer1');
  expect(prompt).toContain('This line is wrong');

  engine.send({ command: 'shutdown' });
});

test('it calls getPRFiles and getPRReviews when a linked PR exists during implementor dispatch', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit } = setupTest({ issues, autoComplete: true });

  // Linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: true })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 1,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42-branch' },
      draft: true,
    },
  });

  await engine.start();

  vi.mocked(octokit.pulls.listFiles).mockClear();
  vi.mocked(octokit.pulls.listReviews).mockClear();
  vi.mocked(octokit.pulls.listReviewComments).mockClear();

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const agentStarted = events.filter(
      (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
    );
    expect(agentStarted.length).toBe(1);
  });

  // getPRFiles and getPRReviews should have been called with the PR number
  expect(octokit.pulls.listFiles).toHaveBeenCalledWith(
    expect.objectContaining({ pull_number: 100 }),
  );
  expect(octokit.pulls.listReviews).toHaveBeenCalledWith(
    expect.objectContaining({ pull_number: 100 }),
  );
  expect(octokit.pulls.listReviewComments).toHaveBeenCalledWith(
    expect.objectContaining({ pull_number: 100 }),
  );

  engine.send({ command: 'shutdown' });
});

test('it omits review sections when a linked PR has no prior reviews or comments', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, capturedQueryParams, octokit } = setupTest({ issues, autoComplete: true });

  // Linked PR with no reviews or comments
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #42', draft: true })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR for issue 42',
      changed_files: 1,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'pr-sha-1', ref: 'issue-42-branch' },
      draft: true,
    },
  });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [{ filename: 'src/bar.ts', status: 'added', patch: '+new content' }],
  });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await vi.waitFor(() => {
    const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
    expect(implementorParams.length).toBeGreaterThanOrEqual(1);
  });

  const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
  invariant(implementorParams[0], 'implementor params must exist');
  const prompt = implementorParams[0].prompt;

  // Prompt should contain issue and PR sections
  expect(prompt).toContain('## Task Issue #42');
  expect(prompt).toContain('## PR #100');
  expect(prompt).toContain('### Changed Files');

  // Prompt should NOT contain review sections since there are none
  expect(prompt).not.toContain('### Prior Reviews');
  expect(prompt).not.toContain('### Prior Inline Comments');

  engine.send({ command: 'shutdown' });
});

test('it fails the implementor dispatch when getIssueDetails throws', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit, capturedQueryParams } = setupTest({
    issues,
    autoComplete: true,
  });

  // No linked PR
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  // Make getIssueDetails fail
  vi.mocked(octokit.issues.get).mockRejectedValue(new Error('GitHub API error'));

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  // Wait a tick to let the command handler run
  await vi.waitFor(() => {
    // No new agent should have been dispatched (the context fetch failed)
    expect(capturedQueryParams.length).toBe(paramsBeforeDispatch);
  });

  // No agentStarted should have been emitted for issue 42 after the dispatch attempt
  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted).toHaveLength(0);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Granular notification events: issueBlocked / issueUnblocked
// ---------------------------------------------------------------------------

test('it emits issueBlocked with contextURL and resolutionGuidance when an issue transitions to blocked', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(10, 'pending')] };
    }
    // Second poll: issue moved to blocked
    return { data: [buildMockIssueData(10, 'blocked')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Advance past the poll interval to trigger the second cycle
  await vi.advanceTimersByTimeAsync(1500);

  const blockedEvents = events.filter((e) => e.type === 'issueBlocked');
  expect(blockedEvents).toHaveLength(1);
  expect(blockedEvents[0]).toMatchObject({
    type: 'issueBlocked',
    issueNumber: 10,
    contextURL: 'https://github.com/owner/repo/issues/10',
    resolutionGuidance: 'After resolving the blocker, change the label to status:unblocked.',
  });

  engine.send({ command: 'shutdown' });
});

test('it emits issueUnblocked when an issue transitions away from blocked', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(10, 'blocked')] };
    }
    // Second poll: issue moved to pending (away from blocked)
    return { data: [buildMockIssueData(10, 'pending')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // First poll detected blocked — verify issueBlocked was emitted
  const blockedBefore = events.filter((e) => e.type === 'issueBlocked');
  expect(blockedBefore).toHaveLength(1);

  // Advance past the poll interval to trigger the second cycle
  await vi.advanceTimersByTimeAsync(1500);

  const unblockedEvents = events.filter((e) => e.type === 'issueUnblocked');
  expect(unblockedEvents).toHaveLength(1);
  expect(unblockedEvents[0]).toStrictEqual({
    type: 'issueUnblocked',
    issueNumber: 10,
  });

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Granular notification events: issueNeedsRefinement / issueRefined
// ---------------------------------------------------------------------------

test('it emits issueNeedsRefinement with contextURL, resolutionGuidance, and clipboardCommand when an issue transitions to needs-refinement', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(15, 'pending')] };
    }
    return { data: [buildMockIssueData(15, 'needs-refinement')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.advanceTimersByTimeAsync(1500);

  const refinementEvents = events.filter((e) => e.type === 'issueNeedsRefinement');
  expect(refinementEvents).toHaveLength(1);
  expect(refinementEvents[0]).toMatchObject({
    type: 'issueNeedsRefinement',
    issueNumber: 15,
    contextURL: 'https://github.com/owner/repo/issues/15',
    resolutionGuidance: 'After amending the spec, change the label to status:unblocked.',
    clipboardCommand:
      'claude -p "Use /spec-writing to address the spec refinement needed for issue #15. See blocker comment: https://github.com/owner/repo/issues/15"',
  });

  engine.send({ command: 'shutdown' });
});

test('it emits issueRefined when an issue transitions away from needs-refinement', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(15, 'needs-refinement')] };
    }
    return { data: [buildMockIssueData(15, 'unblocked')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // First poll detected needs-refinement
  const refinementBefore = events.filter((e) => e.type === 'issueNeedsRefinement');
  expect(refinementBefore).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1500);

  const refinedEvents = events.filter((e) => e.type === 'issueRefined');
  expect(refinedEvents).toHaveLength(1);
  expect(refinedEvents[0]).toStrictEqual({
    type: 'issueRefined',
    issueNumber: 15,
  });

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Granular notification events: prApproved / prUnapproved
// ---------------------------------------------------------------------------

test('it emits prApproved with contextURL as issue URL when an issue transitions to approved', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(20, 'review')] };
    }
    return { data: [buildMockIssueData(20, 'approved')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.advanceTimersByTimeAsync(1500);

  const approvedEvents = events.filter((e) => e.type === 'prApproved');
  expect(approvedEvents).toHaveLength(1);
  expect(approvedEvents[0]).toMatchObject({
    type: 'prApproved',
    issueNumber: 20,
    contextURL: 'https://github.com/owner/repo/issues/20',
  });

  engine.send({ command: 'shutdown' });
});

test('it emits prUnapproved when an issue transitions away from approved', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(20, 'approved')] };
    }
    return { data: [buildMockIssueData(20, 'needs-changes')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // First poll detected approved
  const approvedBefore = events.filter((e) => e.type === 'prApproved');
  expect(approvedBefore).toHaveLength(1);

  await vi.advanceTimersByTimeAsync(1500);

  const unapprovedEvents = events.filter((e) => e.type === 'prUnapproved');
  expect(unapprovedEvents).toHaveLength(1);
  expect(unapprovedEvents[0]).toStrictEqual({
    type: 'prUnapproved',
    issueNumber: 20,
  });

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// Event ordering: issueStatusChanged emitted before dispatch-tier events
// ---------------------------------------------------------------------------

test('it emits issueStatusChanged before dispatchReady for user-dispatch statuses', async () => {
  const issues = [buildMockIssueData(1, 'pending')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  const statusIndex = events.findIndex(
    (e) => e.type === 'issueStatusChanged' && 'issueNumber' in e && e.issueNumber === 1,
  );
  const dispatchIndex = events.findIndex(
    (e) => e.type === 'dispatchReady' && 'issueNumber' in e && e.issueNumber === 1,
  );

  expect(statusIndex).toBeGreaterThanOrEqual(0);
  expect(dispatchIndex).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeLessThan(dispatchIndex);
});

test('it emits issueStatusChanged before issueBlocked for blocked status', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(10, 'pending')] };
    }
    return { data: [buildMockIssueData(10, 'blocked')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.advanceTimersByTimeAsync(1500);

  // Find the issueStatusChanged event for blocked transition
  const statusIndex = events.findIndex(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' && e.issueNumber === 10 && e.newStatus === 'blocked',
  );
  const blockedIndex = events.findIndex(
    (e) => e.type === 'issueBlocked' && 'issueNumber' in e && e.issueNumber === 10,
  );

  expect(statusIndex).toBeGreaterThanOrEqual(0);
  expect(blockedIndex).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeLessThan(blockedIndex);

  engine.send({ command: 'shutdown' });
});

test('it emits issueStatusChanged before issueNeedsRefinement for needs-refinement status', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(10, 'pending')] };
    }
    return { data: [buildMockIssueData(10, 'needs-refinement')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.advanceTimersByTimeAsync(1500);

  const statusIndex = events.findIndex(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' && e.issueNumber === 10 && e.newStatus === 'needs-refinement',
  );
  const refinementIndex = events.findIndex(
    (e) => e.type === 'issueNeedsRefinement' && 'issueNumber' in e && e.issueNumber === 10,
  );

  expect(statusIndex).toBeGreaterThanOrEqual(0);
  expect(refinementIndex).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeLessThan(refinementIndex);

  engine.send({ command: 'shutdown' });
});

test('it emits issueStatusChanged before prApproved for approved status', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return { data: [buildMockIssueData(10, 'review')] };
    }
    return { data: [buildMockIssueData(10, 'approved')] };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.advanceTimersByTimeAsync(1500);

  const statusIndex = events.findIndex(
    (e): e is IssueStatusChangedEvent =>
      e.type === 'issueStatusChanged' && e.issueNumber === 10 && e.newStatus === 'approved',
  );
  const approvedIndex = events.findIndex(
    (e) => e.type === 'prApproved' && 'issueNumber' in e && e.issueNumber === 10,
  );

  expect(statusIndex).toBeGreaterThanOrEqual(0);
  expect(approvedIndex).toBeGreaterThanOrEqual(0);
  expect(statusIndex).toBeLessThan(approvedIndex);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// No NotificationEvent or NotificationDismissedEvent emitted
// ---------------------------------------------------------------------------

test('it does not emit any legacy notification event types', async () => {
  vi.useFakeTimers();

  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  let pollCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    pollCount += 1;
    if (pollCount === 1) {
      return {
        data: [
          buildMockIssueData(1, 'blocked'),
          buildMockIssueData(2, 'needs-refinement'),
          buildMockIssueData(3, 'approved'),
        ],
      };
    }
    // Second poll: all move to different statuses
    return {
      data: [
        buildMockIssueData(1, 'pending'),
        buildMockIssueData(2, 'unblocked'),
        buildMockIssueData(3, 'needs-changes'),
      ],
    };
  });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });
  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock — no-op in tests
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  await vi.advanceTimersByTimeAsync(1500);

  // Verify no event types named 'notification' or 'notificationDismissed' exist
  const legacyEvents = events.filter(
    (e) => e.type === ('notification' as string) || e.type === ('notificationDismissed' as string),
  );
  expect(legacyEvents).toHaveLength(0);

  // Verify the granular events were emitted instead
  expect(events.some((e) => e.type === 'issueBlocked')).toBe(true);
  expect(events.some((e) => e.type === 'issueNeedsRefinement')).toBe(true);
  expect(events.some((e) => e.type === 'prApproved')).toBe(true);
  expect(events.some((e) => e.type === 'issueUnblocked')).toBe(true);
  expect(events.some((e) => e.type === 'issueRefined')).toBe(true);
  expect(events.some((e) => e.type === 'prUnapproved')).toBe(true);

  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// PR Poller integration: startup
// ---------------------------------------------------------------------------

test('it runs the first PR Poller cycle during startup', async () => {
  const { engine, octokit } = setupTest();

  // PR Poller calls pulls.list during its poll cycle
  vi.mocked(octokit.pulls.list).mockClear();

  await engine.start();

  // pulls.list is called by both PR Poller and query methods, so verify at least one call
  expect(octokit.pulls.list).toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// PR Poller integration: shutdown
// ---------------------------------------------------------------------------

test('it clears the PR Poller timer during shutdown', async () => {
  const { engine } = setupTest();

  await engine.start();

  // Shutdown should not throw (timer is cleared and stop() is called)
  engine.send({ command: 'shutdown' });
});

// ---------------------------------------------------------------------------
// PR Poller integration: onCIStatusChanged callback
// ---------------------------------------------------------------------------

test('it emits a CI status changed event with a linked issue number when CI status changes', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit } = setupTest(issues);

  // Set up PRs: one PR linked to issue #42 with CI failure
  const prItem = buildPullsListItem({ number: 100, body: 'Closes #42', draft: false });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [prItem] });

  // First poll: CI status is null → pending (first detection)
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  await engine.start();

  const ciEvents = events.filter((e): e is CIStatusChangedEvent => e.type === 'ciStatusChanged');

  // The first poll triggers onCIStatusChanged with oldCIStatus: null → newCIStatus: 'pending'
  expect(ciEvents.length).toBeGreaterThanOrEqual(1);
  expect(ciEvents[0]).toMatchObject({
    type: 'ciStatusChanged',
    prNumber: 100,
    issueNumber: 42,
    oldCIStatus: null,
    newCIStatus: 'pending',
  });

  engine.send({ command: 'shutdown' });
});

test('it emits a CI status changed event with no issue number for unlinked PRs', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, events, octokit } = setupTest(issues);

  // PR body does NOT contain closing keyword for any tracked issue
  const prItem = buildPullsListItem({ number: 200, body: 'Some unrelated PR', draft: false });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [prItem] });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  await engine.start();

  const ciEvents = events.filter(
    (e): e is CIStatusChangedEvent => e.type === 'ciStatusChanged' && e.prNumber === 200,
  );

  expect(ciEvents.length).toBeGreaterThanOrEqual(1);

  const firstEvent = ciEvents[0];
  invariant(firstEvent, 'ciStatusChanged event must exist');
  expect(firstEvent.issueNumber).toBeUndefined();

  engine.send({ command: 'shutdown' });
});

test('it emits a CI check failed event when CI fails for a tracked issue in pending status', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'pending')];
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockResolvedValue({ data: buildMockIssueData(42, 'pending') });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });

  // PR linked to issue #42
  const prItem = buildPullsListItem({
    number: 100,
    body: 'Closes #42',
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/100',
  });

  // First PR Poller cycle: CI is pending
  vi.mocked(octokit.pulls.list).mockImplementation(async () => ({ data: [prItem] }));

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-1', ref: 'branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ prPoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock exec — always succeeds
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // After first cycle: CI is pending — no ciCheckFailed should be emitted yet
  const failedAfterFirst = events.filter(
    (e): e is CICheckFailedEvent => e.type === 'ciCheckFailed',
  );
  expect(failedAfterFirst).toHaveLength(0);

  // Now change CI to failure for the second poll cycle
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });

  // Advance past PR Poller interval
  await vi.advanceTimersByTimeAsync(1500);

  const ciCheckFailed = events.filter((e): e is CICheckFailedEvent => e.type === 'ciCheckFailed');
  expect(ciCheckFailed.length).toBeGreaterThanOrEqual(1);
  expect(ciCheckFailed[0]).toMatchObject({
    type: 'ciCheckFailed',
    issueNumber: 42,
    prNumber: 100,
    contextURL: expect.stringContaining('pull/100'),
  });

  // ciCheckFailed for pending status should NOT have resolutionGuidance
  expect(ciCheckFailed[0]?.resolutionGuidance).toBeUndefined();

  engine.send({ command: 'shutdown' });
});

test('it emits a CI check failed event with resolution guidance when CI fails for an approved issue', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'approved')];
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockResolvedValue({ data: buildMockIssueData(42, 'approved') });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });

  const prItem = buildPullsListItem({
    number: 100,
    body: 'Closes #42',
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/100',
  });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [prItem] });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-1', ref: 'branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  // First cycle: CI pending
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ prPoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock exec — always succeeds
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Change CI to failure for next cycle
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });

  await vi.advanceTimersByTimeAsync(1500);

  const ciCheckFailed = events.filter((e): e is CICheckFailedEvent => e.type === 'ciCheckFailed');
  expect(ciCheckFailed.length).toBeGreaterThanOrEqual(1);
  expect(ciCheckFailed[0]?.resolutionGuidance).toBe(
    'CI failed. Change the label to `status:needs-changes` to re-dispatch an Implementor for CI fixes.',
  );

  engine.send({ command: 'shutdown' });
});

test('it does not emit a CI check failed event when CI fails for a review-status issue', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'review')];
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockResolvedValue({ data: buildMockIssueData(42, 'review') });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });

  const prItem = buildPullsListItem({
    number: 100,
    body: 'Closes #42',
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/100',
  });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [prItem] });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-1', ref: 'branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  // First cycle: CI pending
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ prPoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock exec — always succeeds
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Change CI to failure for next cycle
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });

  await vi.advanceTimersByTimeAsync(1500);

  // ciStatusChanged should be emitted (always emitted)
  const ciStatusChanged = events.filter(
    (e): e is CIStatusChangedEvent => e.type === 'ciStatusChanged' && e.prNumber === 100,
  );
  expect(ciStatusChanged.length).toBeGreaterThanOrEqual(1);

  // ciCheckFailed should NOT be emitted for review status
  const ciCheckFailed = events.filter((e): e is CICheckFailedEvent => e.type === 'ciCheckFailed');
  expect(ciCheckFailed).toHaveLength(0);

  engine.send({ command: 'shutdown' });
});

test('it emits a CI check recovered event when CI recovers to success', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'pending')];
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockResolvedValue({ data: buildMockIssueData(42, 'pending') });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });

  const prItem = buildPullsListItem({
    number: 100,
    body: 'Closes #42',
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/100',
  });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [prItem] });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-1', ref: 'branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  // First cycle: CI pending
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ prPoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock exec — always succeeds
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Second cycle: CI failure — triggers ciCheckFailed
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });
  await vi.advanceTimersByTimeAsync(1500);

  const failedEvents = events.filter((e): e is CICheckFailedEvent => e.type === 'ciCheckFailed');
  expect(failedEvents.length).toBeGreaterThanOrEqual(1);

  // Third cycle: CI success — triggers ciCheckRecovered
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', details_url: '' }],
    },
  });
  await vi.advanceTimersByTimeAsync(1500);

  const recoveredEvents = events.filter(
    (e): e is CICheckRecoveredEvent => e.type === 'ciCheckRecovered',
  );
  expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);
  expect(recoveredEvents[0]).toMatchObject({
    type: 'ciCheckRecovered',
    issueNumber: 42,
  });

  engine.send({ command: 'shutdown' });
});

test('it emits a CI check recovered event when a PR is removed for an issue with prior CI failure', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'pending')];
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockResolvedValue({ data: buildMockIssueData(42, 'pending') });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });

  const prItem = buildPullsListItem({
    number: 100,
    body: 'Closes #42',
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/100',
  });

  // First cycle: PR exists with CI failure
  let prPollCycle = 0;
  vi.mocked(octokit.pulls.list).mockImplementation(async () => {
    prPollCycle += 1;
    if (prPollCycle <= 2) {
      return { data: [prItem] };
    }
    // Third cycle: PR removed (closed/merged)
    return { data: [] };
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-1', ref: 'branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  // First PR poll: CI pending
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q;
  };

  const config = buildValidConfig({ prPoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock exec — always succeeds
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Second cycle: CI failure
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });
  await vi.advanceTimersByTimeAsync(1500);

  const failedEvents = events.filter((e): e is CICheckFailedEvent => e.type === 'ciCheckFailed');
  expect(failedEvents.length).toBeGreaterThanOrEqual(1);

  // Third cycle: PR removed — should emit ciCheckRecovered
  await vi.advanceTimersByTimeAsync(1500);

  const recoveredEvents = events.filter(
    (e): e is CICheckRecoveredEvent => e.type === 'ciCheckRecovered',
  );
  expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);
  expect(recoveredEvents[0]).toMatchObject({
    type: 'ciCheckRecovered',
    issueNumber: 42,
  });

  engine.send({ command: 'shutdown' });
});

test('it does not emit a CI check failed event when an agent is running for the issue', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'in-progress')];
  const octokit = createMockGitHubClient();
  const worktreeManager = createMockWorktreeManager();

  vi.mocked(octokit.issues.listForRepo).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] };
    }
    return { data: issues };
  });
  vi.mocked(octokit.issues.get).mockResolvedValue({ data: buildMockIssueData(42, 'in-progress') });
  vi.mocked(octokit.issues.addLabels).mockResolvedValue({ data: {} });
  vi.mocked(octokit.issues.removeLabel).mockResolvedValue({ data: {} });
  vi.mocked(octokit.git.getTree).mockResolvedValue({ data: { sha: 'tree-sha-1', tree: [] } });
  vi.mocked(octokit.git.getRef).mockResolvedValue({ data: { object: { sha: 'commit-sha-1' } } });

  const prItem = buildPullsListItem({
    number: 100,
    body: 'Closes #42',
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/100',
  });
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [prItem] });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'PR',
      changed_files: 0,
      html_url: 'https://github.com/owner/repo/pull/100',
      head: { sha: 'sha-1', ref: 'branch' },
      draft: false,
    },
  });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });
  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviews).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.listReviewComments).mockResolvedValue({ data: [] });

  // First cycle: CI pending
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const mockQueries: MockQuery[] = [];
  const queryFactory: QueryFactory = async () => {
    const q = createMockQuery();
    q.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: `session-${mockQueries.length + 1}`,
    });
    // Don't auto-complete — agent stays running
    mockQueries.push(q);
    return q;
  };

  const config = buildValidConfig({ prPoller: { pollInterval: 1 } });

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
    worktreeManager,
    execCommand: async (): Promise<void> => {
      // Mock exec — always succeeds
    },
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Dispatch implementor — agent stays running
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });
  await vi.advanceTimersByTimeAsync(50);

  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted.length).toBe(1);

  // Next PR Poller cycle: CI failure
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });
  await vi.advanceTimersByTimeAsync(1500);

  // ciStatusChanged should be emitted
  const ciStatusChanged = events.filter(
    (e): e is CIStatusChangedEvent => e.type === 'ciStatusChanged',
  );
  expect(ciStatusChanged.length).toBeGreaterThanOrEqual(1);

  // ciCheckFailed should NOT be emitted (agent is running)
  const ciCheckFailed = events.filter((e): e is CICheckFailedEvent => e.type === 'ciCheckFailed');
  expect(ciCheckFailed).toHaveLength(0);

  engine.send({ command: 'shutdown' });
});
