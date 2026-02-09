import { execFileSync } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import { buildValidConfig } from '../test-utils/build-valid-config';
import { createMockGitHubClient } from '../test-utils/create-mock-github-client';
import type { AgentFailedEvent, EngineEvent, IssueStatusChangedEvent } from '../types';
import type { AgentQuery, QueryFactory } from './agent-manager/types';
import { createEngine } from './create-engine';
import type { GitHubClient } from './github-client/types';
import type { WorktreeManager } from './worktree-manager/types';

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
    pushMessage(msg: unknown): void;
    end(): void;
  };

function createMockQuery(): MockQuery {
  const pendingReads: Array<{ resolve: (result: IteratorResult<unknown>) => void }> = [];
  const bufferedMessages: unknown[] = [];
  let ended = false;

  const mockQuery: MockQuery = {
    pushMessage(msg: unknown) {
      if (pendingReads.length > 0) {
        const pending = pendingReads.shift()!;
        pending.resolve({ value: msg, done: false });
        return;
      }
      bufferedMessages.push(msg);
    },

    end() {
      ended = true;
      for (const pending of pendingReads) {
        pending.resolve({ value: undefined, done: true });
      }
      pendingReads.length = 0;
    },

    interrupt: vi.fn().mockResolvedValue(undefined),

    next() {
      if (bufferedMessages.length > 0) {
        const msg = bufferedMessages.shift()!;
        return Promise.resolve({ value: msg, done: false });
      }
      if (ended) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        pendingReads.push({ resolve });
      });
    },

    return() {
      ended = true;
      for (const pending of pendingReads) {
        pending.resolve({ value: undefined, done: true });
      }
      pendingReads.length = 0;
      return Promise.resolve({ value: undefined, done: true as const });
    },

    throw() {
      ended = true;
      for (const pending of pendingReads) {
        pending.resolve({ value: undefined, done: true });
      }
      pendingReads.length = 0;
      return Promise.resolve({ value: undefined, done: true as const });
    },

    [Symbol.asyncIterator]() {
      return mockQuery;
    },
  };

  return mockQuery;
}

function buildMockIssueData(
  number: number,
  status: string,
  title = `Issue #${number}`,
  priority = 'priority:medium',
) {
  return {
    number,
    title,
    body: `Task body for #${number}`,
    labels: [{ name: 'task:implement' }, { name: `status:${status}` }, { name: priority }],
    created_at: '2026-01-01T00:00:00Z',
  };
}

function setupMockGitHubClient(
  octokit: GitHubClient,
  issues: ReturnType<typeof buildMockIssueData>[] = [],
) {
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
      head: { sha: 'abc123' },
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

type SetupOptions = {
  issues?: ReturnType<typeof buildMockIssueData>[];
  autoComplete?: boolean;
  shutdownTimeout?: number;
};

function setupTest(
  issueOverridesOrOptions?: ReturnType<typeof buildMockIssueData>[] | SetupOptions,
) {
  const options: SetupOptions = Array.isArray(issueOverridesOrOptions)
    ? { issues: issueOverridesOrOptions }
    : (issueOverridesOrOptions ?? {});

  const issues = options.issues ?? [];
  const autoComplete = options.autoComplete ?? true;

  const octokit = createMockGitHubClient();
  const mockQueries: MockQuery[] = [];
  const worktreeManager = createMockWorktreeManager();

  const queryFactory: QueryFactory = async (params) => {
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
  engine.on((event) => events.push(event));

  return { engine, events, octokit, queryFactory, mockQueries, config, worktreeManager };
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
  const queryFactory: QueryFactory = async (params) => {
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
  engine.on((event) => events.push(event));

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

  const firstEvent = statusEvents[0]!;
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
  const unsub = engine.on((event) => laterEvents.push(event));

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

  // Record queries created during startup (auto-dispatch reviewer for review)
  const queriesAfterStart = mockQueries.length;

  engine.send({ command: 'dispatchImplementor', issueNumber: 42 });

  await new Promise((resolve) => setTimeout(resolve, 50));

  // No new queries beyond what startup created
  expect(mockQueries.length).toBe(queriesAfterStart);
});

// ---------------------------------------------------------------------------
// Command routing: dispatchReviewer
// ---------------------------------------------------------------------------

test('it auto-dispatches a reviewer when the issue is in review status', async () => {
  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events } = setupTest(issues);

  await engine.start();

  // Wait for async agent monitoring to process
  await new Promise((resolve) => setTimeout(resolve, 50));

  const agentStarted = events.filter((e) => e.type === 'agentStarted');
  expect(agentStarted.length).toBeGreaterThan(0);
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
  const queryFactory: QueryFactory = async (params) => {
    const q = createMockQuery();
    q.end();
    return q;
  };
  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });

  let callCount = 0;
  vi.mocked(octokit.issues.listForRepo).mockImplementation(async () => {
    callCount++;
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
  const { engine, events, mockQueries } = setupTest({ issues, autoComplete: false });

  await engine.start();

  // Wait for auto-dispatch of reviewer (review status triggers auto-dispatch)
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
  expect(agentFailed[0]!.error).toContain('Cancelled');
});

test('it cancels running agents after shutdown timeout expires', async () => {
  vi.useFakeTimers();

  const issues = [buildMockIssueData(42, 'review')];
  const { engine, events, mockQueries } = setupTest({
    issues,
    autoComplete: false,
    shutdownTimeout: 5,
  });

  await engine.start();

  // Wait for auto-dispatch of reviewer
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

  vi.useRealTimers();
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
    pollCount++;
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
  engine.on((event) => events.push(event));

  await engine.start();

  // Wait for the auto-dispatched reviewer to start
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
