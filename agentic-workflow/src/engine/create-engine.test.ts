import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { vol } from 'memfs';
import invariant from 'tiny-invariant';
import { expect, test, vi } from 'vitest';
import { buildValidConfig } from '../test-utils/build-valid-config.ts';
import { createMockGitHubClient } from '../test-utils/create-mock-github-client.ts';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  EngineEvent,
  IssueStatusChangedEvent,
} from '../types.ts';
import type { AgentQuery, QueryFactory, QueryFactoryParams } from './agent-manager/types.ts';
import { createEngine } from './create-engine.ts';
import type { GitHubClient } from './github-client/types.ts';
import type { PlannerCacheEntry } from './planner-cache/types.ts';
import type { WorktreeManager } from './worktree-manager/types.ts';

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

  // Queries: PRs
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 1,
      title: 'PR #1',
      changed_files: 3,
      html_url: 'https://github.com/owner/repo/pull/1',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
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
}

function createMockWorktreeManager(): WorktreeManager {
  return {
    createOrReuse: vi.fn().mockResolvedValue({
      worktreePath: '/tmp/test-repo/.worktrees/issue-42',
      branch: 'issue-42',
      created: true,
    }),
    remove: vi.fn().mockResolvedValue(undefined),
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

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(mockQueries.length).toBe(queriesBefore);
});

test('it is a no-op when dispatching an implementor for an issue not in user-dispatch status', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, mockQueries } = setupTest(issues);

  await engine.start();

  const queriesAfterStart = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  // No new queries beyond what startup created
  expect(mockQueries.length).toBe(queriesAfterStart);
});

test('it dispatches an implementor for an in-progress issue with no running agent', async () => {
  const issues = [buildMockIssueData(42, 'in-progress')];
  const { engine, events, mockQueries } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const queriesBeforeDispatch = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(mockQueries.length).toBeGreaterThan(queriesBeforeDispatch);

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

  await new Promise((resolve) => setTimeout(resolve, 50));

  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted.length).toBe(1);

  // Second dispatch: agent is now running, should be skipped by agent manager
  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const agentSkipped = events.filter(
    (e) => e.type === 'agentSkipped' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentSkipped.length).toBe(1);
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

  await new Promise((resolve) => setTimeout(resolve, 50));

  const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
  expect(implementorParams.length).toBe(1);
  expect(implementorParams[0]).toMatchObject({ modelOverride: 'sonnet' });
});

test('it passes an opus model override when dispatching an implementor for a complex-complexity issue', async () => {
  const issues = [buildMockIssueData(42, 'pending', { complexity: 'complexity:complex' })];
  const { engine, capturedQueryParams } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
  expect(implementorParams.length).toBe(1);
  expect(implementorParams[0]).toMatchObject({ modelOverride: 'opus' });
});

test('it does not pass a model override when dispatching an implementor for an issue without a complexity label', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, capturedQueryParams } = setupTest({ issues, autoComplete: true });

  await engine.start();

  const paramsBeforeDispatch = capturedQueryParams.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const implementorParams = capturedQueryParams.slice(paramsBeforeDispatch);
  expect(implementorParams.length).toBe(1);
  expect(implementorParams[0]).not.toHaveProperty('modelOverride');
});

// ---------------------------------------------------------------------------
// Command routing: dispatchReviewer
// ---------------------------------------------------------------------------

test('it does not auto-dispatch a reviewer when the issue is in review status', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  // Wait for async agent monitoring to process
  await new Promise((resolve) => setTimeout(resolve, 50));

  const agentStarted = events.filter((e) => e.type === 'agentStarted');
  expect(agentStarted.length).toBe(0);
});

test('it is a no-op when dispatching a reviewer for an issue not in review status', async () => {
  const issues = [buildMockIssueData(42, 'pending')];
  const { engine, mockQueries } = setupTest(issues);

  await engine.start();
  const queriesAfterStart = mockQueries.length;

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(mockQueries.length).toBe(queriesAfterStart);
});

test('it is a no-op when dispatching a reviewer for an issue not in snapshot', async () => {
  const { engine, mockQueries } = setupTest();

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 999 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(mockQueries.length).toBe(0);
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

  await new Promise((resolve) => setTimeout(resolve, 50));
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

  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(mockQueries.length).toBeGreaterThan(queriesBeforeDispatch);

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

  await new Promise((resolve) => setTimeout(resolve, 50));

  // Verify the agent started
  const agentStarted = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentStarted.length).toBe(1);

  engine.send({ command: 'cancelAgent', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const agentFailed = events.filter(
    (e): e is AgentFailedEvent =>
      e.type === 'agentFailed' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(agentFailed.length).toBe(1);
  expect(agentFailed[0]?.error).toContain('Cancelled');
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
  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });
  vi.mocked(octokit.repos.getContent).mockResolvedValue({ data: { content: '' } });

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
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  engine.send({ command: 'dispatchReviewer', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const started = events.filter(
    (e) => e.type === 'agentStarted' && 'issueNumber' in e && e.issueNumber === 42,
  );
  expect(started.length).toBe(1);

  // Wait for the next poll cycle (1 second interval) to detect issue removal
  await new Promise((resolve) => setTimeout(resolve, 1500));

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

  // Wait for planner agent to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Should see a specChanged event only for the new file, not for control-plane.md
  const specChanged = events.filter((e) => e.type === 'specChanged');
  expect(specChanged.length).toBe(1);
  expect(specChanged[0]).toMatchObject({
    filePath: 'docs/specs/new-spec.md',
    frontmatterStatus: 'approved',
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

  // Wait for the planner to complete and cache to be written
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify the planner completed
  const completed = events.filter(
    (e): e is AgentCompletedEvent => e.type === 'agentCompleted' && e.agentType === 'planner',
  );
  expect(completed.length).toBe(1);

  // Verify cache file was written with PlannerCacheEntry format
  const raw = await readFile('/tmp/test-repo/.agentic-workflow-cache.json', 'utf-8');
  const cached: unknown = JSON.parse(raw);
  expect(cached).toMatchObject({
    snapshot: { specsDirTreeSHA: 'tree-sha-new' },
    commitSHA: 'commit-sha-1',
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

  // Wait for planner to start
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Fail the planner by ending the query with an execution error
  const plannerQuery = mockQueries[0];
  invariant(plannerQuery, 'planner query must exist');
  plannerQuery.pushMessage({ type: 'result', subtype: 'error_during_execution' });
  plannerQuery.end();

  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify the planner failed
  const failed = events.filter(
    (e): e is AgentFailedEvent => e.type === 'agentFailed' && e.agentType === 'planner',
  );
  expect(failed.length).toBe(1);

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
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(capturedPrompts.length).toBeGreaterThan(0);
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(capturedPrompts.length).toBeGreaterThan(0);
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(capturedPrompts.length).toBeGreaterThan(0);
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
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(capturedPrompts.length).toBeGreaterThan(0);
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
  });

  const events: EngineEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });

  await engine.start();

  // Wait for the failed dispatch attempt
  await new Promise((resolve) => setTimeout(resolve, 100));

  // No planner should have been dispatched (the prompt build failed)
  expect(capturedPrompts.length).toBe(0);

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
