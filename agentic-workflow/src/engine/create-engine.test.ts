import { expect, type Mock, test, vi } from 'vitest';
import { buildValidConfig } from '../test-utils/build-valid-config';
import { createMockGitHubClient } from '../test-utils/create-mock-github-client';
import type { EngineEvent, IssueStatusChangedEvent } from '../types';
import type { QueryFactory, QueryFactoryParams } from './agent-manager/types';
import { createEngine } from './create-engine';
import type { GitHubClient } from './github-client/types';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

type MockQuery = {
  pushMessage(msg: unknown): void;
  end(): void;
  interrupt: ReturnType<typeof vi.fn>;
  next(): Promise<IteratorResult<unknown>>;
  return(): Promise<IteratorResult<unknown>>;
  throw(): Promise<IteratorResult<unknown>>;
  [Symbol.asyncIterator](): MockQuery;
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
  (octokit.issues.listForRepo as Mock).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: [] }; // No in-progress issues by default (startup recovery)
    }
    return { data: issues };
  });
  (octokit.issues.get as Mock).mockImplementation(async (params: { issue_number: number }) => {
    const issue = issues.find((i) => i.number === params.issue_number);
    return { data: issue ?? buildMockIssueData(params.issue_number, 'pending') };
  });
  (octokit.issues.addLabels as Mock).mockResolvedValue({ data: {} });
  (octokit.issues.removeLabel as Mock).mockResolvedValue({ data: {} });

  // SpecPoller: no tree changes by default
  (octokit.git.getTree as Mock).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  (octokit.git.getRef as Mock).mockResolvedValue({
    data: { object: { sha: 'commit-sha-1' } },
  });

  // Queries: PRs
  (octokit.pulls.list as Mock).mockResolvedValue({ data: [] });
  (octokit.pulls.get as Mock).mockResolvedValue({
    data: {
      number: 1,
      title: 'PR #1',
      changed_files: 3,
      html_url: 'https://github.com/owner/repo/pull/1',
      head: { sha: 'abc123' },
    },
  });
  (octokit.repos.getCombinedStatusForRef as Mock).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });
  (octokit.checks.listForRef as Mock).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });
  (octokit.repos.getContent as Mock).mockResolvedValue({
    data: { content: '' },
  });
}

function setupTest(issueOverrides: ReturnType<typeof buildMockIssueData>[] = []) {
  const octokit = createMockGitHubClient();
  const mockQueries: MockQuery[] = [];

  const queryFactory: QueryFactory = (params) => {
    const q = createMockQuery();
    // Auto-complete the session immediately
    q.pushMessage({
      type: 'system',
      subtype: 'init',
      session_id: `session-${mockQueries.length + 1}`,
    });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    mockQueries.push(q);
    return q as unknown as ReturnType<QueryFactory>;
  };

  const config = buildValidConfig();

  setupMockGitHubClient(octokit, issueOverrides);

  const engine = createEngine(config, {
    octokit,
    queryFactory,
    repoRoot: '/tmp/test-repo',
  });

  const events: EngineEvent[] = [];
  engine.on((event) => events.push(event));

  return { engine, events, octokit, queryFactory, mockQueries, config };
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
  const queryFactory: QueryFactory = (params) => {
    const q = createMockQuery();
    q.pushMessage({ type: 'system', subtype: 'init', session_id: 'session-1' });
    q.pushMessage({ type: 'result', subtype: 'success' });
    q.end();
    return q as unknown as ReturnType<QueryFactory>;
  };
  const config = buildValidConfig();

  // Startup recovery query returns in-progress issues
  const recoveryIssues = [buildMockIssueData(5, 'in-progress')];

  (octokit.issues.listForRepo as Mock).mockImplementation(async (params: { labels: string }) => {
    if (params.labels.includes('status:in-progress')) {
      return { data: recoveryIssues };
    }
    // Regular poll returns the issue as pending (after recovery reset)
    return { data: [buildMockIssueData(5, 'pending')] };
  });

  (octokit.issues.addLabels as Mock).mockResolvedValue({ data: {} });
  (octokit.issues.removeLabel as Mock).mockResolvedValue({ data: {} });
  (octokit.git.getTree as Mock).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  (octokit.git.getRef as Mock).mockResolvedValue({
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
  const queryFactory: QueryFactory = (params) => {
    const q = createMockQuery();
    q.end();
    return q as unknown as ReturnType<QueryFactory>;
  };
  const config = buildValidConfig({ issuePoller: { pollInterval: 1 } });

  let callCount = 0;
  (octokit.issues.listForRepo as Mock).mockImplementation(async () => {
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
  (octokit.git.getTree as Mock).mockResolvedValue({
    data: { sha: 'tree-sha-1', tree: [] },
  });
  (octokit.git.getRef as Mock).mockResolvedValue({
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
