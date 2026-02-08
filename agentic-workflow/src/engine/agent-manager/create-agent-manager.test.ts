import { fs, vol } from 'memfs';
import { expect, test, vi } from 'vitest';
import type { AgentCompletedEvent, AgentFailedEvent, EngineEvent } from '../../types';
import { createEventEmitter } from '../event-emitter/create-event-emitter';
import type { WorktreeManager } from '../worktree-manager/types';
import { createAgentManager } from './create-agent-manager';
import type { AgentManager, QueryFactory, QueryFactoryParams } from './types';

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
  const pendingReads: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
  }> = [];
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

function createMockWorktreeManager(): WorktreeManager {
  return {
    createOrReuse: vi.fn().mockResolvedValue({
      worktreePath: '/repo/.worktrees/issue-42',
      branch: 'issue-42',
      created: true,
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

type SetupContext = {
  manager: AgentManager;
  emitter: ReturnType<typeof createEventEmitter>;
  worktreeManager: WorktreeManager;
  events: EngineEvent[];
  mockQueries: MockQuery[];
  queryParams: QueryFactoryParams[];
};

type SetupOverrides = {
  maxAgentDuration?: number;
  loggingEnabled?: boolean;
  logsDir?: string;
};

function setupTest(overrides?: Partial<SetupOverrides>): SetupContext {
  const emitter = createEventEmitter();
  const worktreeManager = createMockWorktreeManager();
  const events: EngineEvent[] = [];
  const mockQueries: MockQuery[] = [];
  const queryParams: QueryFactoryParams[] = [];

  emitter.on((event) => events.push(event));

  const queryFactory: QueryFactory = (params) => {
    queryParams.push(params);
    const mockQuery = createMockQuery();
    mockQueries.push(mockQuery);
    return mockQuery as unknown as ReturnType<QueryFactory>;
  };

  const manager = createAgentManager({
    emitter,
    worktreeManager,
    repoRoot: '/repo',
    agentPlanner: 'planner',
    agentImplementor: 'implementor',
    agentReviewer: 'reviewer',
    maxAgentDuration: overrides?.maxAgentDuration ?? 1800,
    queryFactory,
    loggingEnabled: overrides?.loggingEnabled ?? false,
    logsDir: overrides?.logsDir ?? '/tmp/logs',
  });

  return { manager, emitter, worktreeManager, events, mockQueries, queryParams };
}

function buildInitMessage(sessionID: string) {
  return {
    type: 'system' as const,
    subtype: 'init' as const,
    session_id: sessionID,
    uuid: '00000000-0000-0000-0000-000000000001',
    agents: [],
    apiKeySource: 'user' as const,
    cwd: '/repo',
    tools: [],
    mcp_servers: [],
    model: 'claude-opus-4-6',
    permissionMode: 'bypassPermissions' as const,
    slash_commands: [],
    output_style: 'text',
  };
}

function buildAssistantMessage(text: string) {
  return {
    type: 'assistant' as const,
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'test-session',
    message: {
      content: [{ type: 'text' as const, text }],
    },
    parent_tool_use_id: null,
  };
}

function buildSuccessResult() {
  return {
    type: 'result' as const,
    subtype: 'success' as const,
    uuid: '00000000-0000-0000-0000-000000000003',
    session_id: 'test-session',
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 5,
    result: 'Done',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
  };
}

function buildErrorResult() {
  return {
    type: 'result' as const,
    subtype: 'error_during_execution' as const,
    uuid: '00000000-0000-0000-0000-000000000004',
    session_id: 'test-session',
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: true,
    num_turns: 2,
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 50,
      output_tokens: 100,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
  };
}

async function drain() {
  // Multiple ticks to allow async generator protocol to process
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Implementor dispatch
// ---------------------------------------------------------------------------

test('it creates a worktree and agent session when dispatching an implementor', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });

  expect(ctx.worktreeManager.createOrReuse).toHaveBeenCalledWith(42);
  expect(ctx.mockQueries).toHaveLength(1);
  expect(ctx.queryParams[0]).toMatchObject({
    prompt: '42',
    agent: 'implementor',
    cwd: '/repo/.worktrees/issue-42',
  });
});

test('it emits agentSkipped when dispatching an implementor for an issue with a running agent', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });

  expect(ctx.mockQueries).toHaveLength(1);
  const skipped = ctx.events.find((e) => e.type === 'agentSkipped');
  expect(skipped).toEqual({
    type: 'agentSkipped',
    agentType: 'implementor',
    issueNumber: 42,
  });
});

test('it emits agentStarted with session ID when the init message is received', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('abc-123'));
  await drain();

  const started = ctx.events.find((e) => e.type === 'agentStarted');
  expect(started).toEqual({
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 42,
    sessionID: 'abc-123',
  });
});

test('it sets the working directory to the worktree path for implementors', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });

  expect(ctx.queryParams[0]).toMatchObject({
    cwd: '/repo/.worktrees/issue-42',
  });
});

test('it emits agentCompleted and removes worktree when an implementor session succeeds', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const completed = ctx.events.find((e) => e.type === 'agentCompleted');
  expect(completed).toEqual({
    type: 'agentCompleted',
    agentType: 'implementor',
    issueNumber: 42,
    sessionID: 'session-1',
  });
  expect(ctx.worktreeManager.remove).toHaveBeenCalledWith(42);
  expect(ctx.manager.isRunning(42)).toBe(false);
});

test('it emits agentFailed with worktree path and preserves worktree when an implementor session fails', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildErrorResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).toEqual({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 42,
    error: 'Agent session ended with error',
    sessionID: 'session-1',
    worktreePath: '/repo/.worktrees/issue-42',
  });
  expect(ctx.worktreeManager.remove).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Reviewer dispatch
// ---------------------------------------------------------------------------

test('it sets the working directory to the repo root for reviewers', () => {
  const ctx = setupTest();

  ctx.manager.dispatchReviewer({ issueNumber: 10 });

  expect(ctx.queryParams[0]).toMatchObject({
    prompt: '10',
    agent: 'reviewer',
    cwd: '/repo',
  });
});

test('it emits agentSkipped when dispatching a reviewer for an issue with a running agent', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 10 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.manager.dispatchReviewer({ issueNumber: 10 });

  expect(ctx.mockQueries).toHaveLength(1);
  const skipped = ctx.events.find((e) => e.type === 'agentSkipped');
  expect(skipped).toEqual({
    type: 'agentSkipped',
    agentType: 'reviewer',
    issueNumber: 10,
  });
});

test('it passes the issue number as the initial prompt for reviewers', () => {
  const ctx = setupTest();

  ctx.manager.dispatchReviewer({ issueNumber: 7 });

  expect(ctx.queryParams[0]).toMatchObject({
    prompt: '7',
  });
});

test('it emits agentCompleted and does not remove worktree for reviewer sessions', async () => {
  const ctx = setupTest();

  ctx.manager.dispatchReviewer({ issueNumber: 10 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-r'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const completed = ctx.events.find((e) => e.type === 'agentCompleted');
  expect(completed).toEqual({
    type: 'agentCompleted',
    agentType: 'reviewer',
    issueNumber: 10,
    sessionID: 'session-r',
  });
  expect(ctx.worktreeManager.remove).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Planner dispatch
// ---------------------------------------------------------------------------

test('it sets the working directory to the repo root for planners', () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });

  expect(ctx.queryParams[0]).toMatchObject({
    agent: 'planner',
    cwd: '/repo',
  });
});

test('it passes spec paths space-separated as the initial prompt for planners', () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md', 'docs/specs/b.md'] });

  expect(ctx.queryParams[0]).toMatchObject({
    prompt: 'docs/specs/a.md docs/specs/b.md',
  });
});

test('it emits agentSkipped with deferred paths when a planner is already running', async () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-p'));
  await drain();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/b.md'] });

  expect(ctx.mockQueries).toHaveLength(1);
  const skipped = ctx.events.find((e) => e.type === 'agentSkipped');
  expect(skipped).toEqual({
    type: 'agentSkipped',
    agentType: 'planner',
    specPaths: ['docs/specs/b.md'],
  });
});

test('it emits agentCompleted for planner sessions', async () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-p'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const completed = ctx.events.find((e) => e.type === 'agentCompleted');
  expect(completed).toEqual({
    type: 'agentCompleted',
    agentType: 'planner',
    specPaths: ['docs/specs/a.md'],
    sessionID: 'session-p',
  });
  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

// ---------------------------------------------------------------------------
// Planner streams are not exposed
// ---------------------------------------------------------------------------

test('it returns null from getAgentStream for planner sessions since they have no issue number', () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });

  expect(ctx.manager.getAgentStream(0)).toBeNull();
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

test('it cancels a running agent session and emits agentFailed', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.manager.cancelAgent(42);
  await drain();

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).toMatchObject({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 42,
    error: 'Cancelled by user',
    sessionID: 'session-1',
    worktreePath: '/repo/.worktrees/issue-42',
  });
  expect(ctx.manager.isRunning(42)).toBe(false);
});

test('it is a no-op when cancelling an agent for an issue with no running session', () => {
  const ctx = setupTest();

  ctx.manager.cancelAgent(99);

  expect(ctx.events).toHaveLength(0);
});

test('it cancels a running planner session and emits agentFailed', async () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-p'));
  await drain();

  ctx.manager.cancelPlanner();
  await drain();

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).toMatchObject({
    type: 'agentFailed',
    agentType: 'planner',
    error: 'Cancelled by user',
    sessionID: 'session-p',
    specPaths: ['docs/specs/a.md'],
  });
  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

test('it is a no-op when cancelling the planner with no running session', () => {
  const ctx = setupTest();

  ctx.manager.cancelPlanner();

  expect(ctx.events).toHaveLength(0);
});

test('it completes the async iterable when an agent session is cancelled', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('Hello'));
  await drain();

  const stream = ctx.manager.getAgentStream(42);
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  const streamPromise = (async () => {
    for await (const chunk of stream!) {
      chunks.push(chunk);
    }
  })();

  await drain();

  ctx.manager.cancelAgent(42);
  await drain();
  await streamPromise;

  expect(chunks).toContain('Hello');
});

// ---------------------------------------------------------------------------
// Stream accessor
// ---------------------------------------------------------------------------

test('it returns null from getAgentStream when no agent is running for the issue', () => {
  const ctx = setupTest();

  expect(ctx.manager.getAgentStream(99)).toBeNull();
});

test('it yields plain text output chunks from the agent stream', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('Hello world'));
  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('More output'));
  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  // After completion, stream returns null since agent is no longer running
  const stream = ctx.manager.getAgentStream(42);
  expect(stream).toBeNull();
});

test('it yields buffered and live chunks through the async iterable', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('Chunk 1'));
  await drain();

  const stream = ctx.manager.getAgentStream(42);
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  const readPromise = (async () => {
    for await (const chunk of stream!) {
      chunks.push(chunk);
    }
  })();

  await drain();

  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('Chunk 2'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();
  await readPromise;

  expect(chunks).toEqual(['Chunk 1', 'Chunk 2']);
});

// ---------------------------------------------------------------------------
// Duration timeout
// ---------------------------------------------------------------------------

test('it cancels a session that exceeds the max duration', async () => {
  vi.useFakeTimers();

  const ctx = setupTest({ maxAgentDuration: 10 });

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));

  // Allow the monitoring loop to start consuming
  await vi.advanceTimersByTimeAsync(0);

  vi.advanceTimersByTime(10_000);

  await vi.advanceTimersByTimeAsync(0);

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).toMatchObject({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 42,
    sessionID: 'session-1',
  });
  expect((failed as { error: string }).error).toContain('exceeded max duration');
  expect(ctx.manager.isRunning(42)).toBe(false);

  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tracking queries
// ---------------------------------------------------------------------------

test('it tracks whether an agent is running for a given issue', async () => {
  const ctx = setupTest();

  expect(ctx.manager.isRunning(42)).toBe(false);

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });

  expect(ctx.manager.isRunning(42)).toBe(true);

  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  expect(ctx.manager.isRunning(42)).toBe(false);
});

test('it tracks whether a planner is running', async () => {
  const ctx = setupTest();

  expect(ctx.manager.isPlannerRunning()).toBe(false);

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });

  expect(ctx.manager.isPlannerRunning()).toBe(true);

  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-p'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

test('it returns all running session IDs', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 1 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-impl'));
  await drain();

  ctx.manager.dispatchReviewer({ issueNumber: 2 });
  ctx.mockQueries[1]!.pushMessage(buildInitMessage('session-rev'));
  await drain();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[2]!.pushMessage(buildInitMessage('session-plan'));
  await drain();

  const ids = ctx.manager.getRunningSessionIDs();
  expect(ids).toContain('session-impl');
  expect(ids).toContain('session-rev');
  expect(ids).toContain('session-plan');
  expect(ids).toHaveLength(3);
});

// ---------------------------------------------------------------------------
// Cancel all
// ---------------------------------------------------------------------------

test('it cancels all running sessions when cancelAll is called', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 1 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.manager.dispatchReviewer({ issueNumber: 2 });
  ctx.mockQueries[1]!.pushMessage(buildInitMessage('session-2'));
  await drain();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[2]!.pushMessage(buildInitMessage('session-3'));
  await drain();

  ctx.manager.cancelAll();
  await drain();

  const failures = ctx.events.filter((e) => e.type === 'agentFailed');
  expect(failures).toHaveLength(3);
  expect(ctx.manager.isRunning(1)).toBe(false);
  expect(ctx.manager.isRunning(2)).toBe(false);
  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

// ---------------------------------------------------------------------------
// Session ID is included in failed events
// ---------------------------------------------------------------------------

test('it includes the session ID in the agentFailed event for implementor failures', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('my-session-id'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildErrorResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).toMatchObject({
    sessionID: 'my-session-id',
  });
});

// ---------------------------------------------------------------------------
// Does not include worktreePath for non-implementor failures
// ---------------------------------------------------------------------------

test('it does not include worktreePath in agentFailed events for reviewers', async () => {
  const ctx = setupTest();

  ctx.manager.dispatchReviewer({ issueNumber: 10 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-r'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildErrorResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).not.toHaveProperty('worktreePath');
});

test('it does not include worktreePath in agentFailed events for planners', async () => {
  const ctx = setupTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-p'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildErrorResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).not.toHaveProperty('worktreePath');
});

// ---------------------------------------------------------------------------
// Guard: only one agent per issue across types
// ---------------------------------------------------------------------------

test('it emits agentSkipped when dispatching a reviewer for an issue already running an implementor', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 5 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-impl'));
  await drain();

  ctx.manager.dispatchReviewer({ issueNumber: 5 });

  const skipped = ctx.events.find((e) => e.type === 'agentSkipped');
  expect(skipped).toEqual({
    type: 'agentSkipped',
    agentType: 'reviewer',
    issueNumber: 5,
  });
  expect(ctx.mockQueries).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Filters non-text content from assistant messages
// ---------------------------------------------------------------------------

test('it only yields text content from assistant messages and filters out tool use blocks', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  // Message with mixed content including tool_use blocks
  ctx.mockQueries[0]!.pushMessage({
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'test-session',
    message: {
      content: [
        { type: 'text', text: 'Let me check that' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
        { type: 'text', text: ' file.' },
      ],
    },
    parent_tool_use_id: null,
  });
  await drain();

  const stream = ctx.manager.getAgentStream(42);
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  const readPromise = (async () => {
    for await (const chunk of stream!) {
      chunks.push(chunk);
    }
  })();

  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();
  await readPromise;

  // The text should be concatenated, tool_use blocks filtered out
  expect(chunks).toEqual(['Let me check that file.']);
});

// ---------------------------------------------------------------------------
// Allows dispatching a new session after the previous one completes
// ---------------------------------------------------------------------------

test('it allows dispatching a new implementor after the previous one completes', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  expect(ctx.manager.isRunning(42)).toBe(false);

  // Should be able to dispatch again
  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  expect(ctx.manager.isRunning(42)).toBe(true);
  expect(ctx.mockQueries).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Session logging — setup helper
// ---------------------------------------------------------------------------

function setupLoggingTest(overrides?: Partial<SetupOverrides>): SetupContext {
  vol.reset();
  return setupTest({
    loggingEnabled: true,
    logsDir: '/test-logs',
    ...overrides,
  });
}

function readLogFiles(): string[] {
  try {
    const dir = vol.readdirSync('/test-logs') as string[];
    return dir.filter((f) => f.endsWith('.log')).sort();
  } catch {
    return [];
  }
}

function readLogContent(fileName: string): string {
  return vol.readFileSync(`/test-logs/${fileName}`, 'utf-8') as string;
}

// ---------------------------------------------------------------------------
// Session logging — log file creation
// ---------------------------------------------------------------------------

test('it creates a log file with session header when logging is enabled and an init message is received', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-abc'));
  await drain();

  const files = readLogFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d+-implementor-42\.log$/);

  const content = readLogContent(files[0]!);
  expect(content).toContain('=== Agent Session ===');
  expect(content).toContain('Type:       implementor');
  expect(content).toContain('Session ID: session-abc');
  expect(content).toContain('Issue:      #42');
  expect(content).toContain('=== Messages ===');
  expect(content).toContain('SYSTEM init');
});

test('it names planner log files without a context suffix', async () => {
  const ctx = setupLoggingTest();

  ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-p'));
  await drain();

  const files = readLogFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d+-planner\.log$/);

  const content = readLogContent(files[0]!);
  expect(content).toContain('Spec Paths: docs/specs/a.md');
});

test('it does not create a log file when logging is disabled', async () => {
  const ctx = setupTest({ loggingEnabled: false, logsDir: '/test-logs' });
  vol.reset();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-abc'));
  await drain();

  const files = readLogFiles();
  expect(files).toHaveLength(0);
});

test('it creates the logs directory automatically when it does not exist', async () => {
  vol.reset();
  const ctx = setupTest({ loggingEnabled: true, logsDir: '/new-logs-dir' });

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-abc'));
  await drain();

  const dir = vol.readdirSync('/new-logs-dir') as string[];
  expect(dir.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Session logging — message formatting
// ---------------------------------------------------------------------------

test('it appends formatted assistant text messages to the log file', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('Let me read the spec.'));
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}\] ASSISTANT\n {2}Let me read the spec\./);
});

test('it logs tool use blocks with only the tool name', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage({
    type: 'assistant' as const,
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'test-session',
    message: {
      content: [
        { type: 'tool_use' as const, id: 'tool-1', name: 'Read', input: { file: '/foo.ts' } },
      ],
    },
    parent_tool_use_id: null,
  });
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toContain('[tool_use] Read');
  expect(content).not.toContain('/foo.ts');
});

test('it logs unknown message types with raw JSON', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  const userMessage = { type: 'user', content: 'hello' };
  ctx.mockQueries[0]!.pushMessage(userMessage);
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toMatch(/\[\d{2}:\d{2}:\d{2}\] UNKNOWN user/);
  expect(content).toContain(JSON.stringify(userMessage));
});

// ---------------------------------------------------------------------------
// Session logging — footer and logFilePath in events
// ---------------------------------------------------------------------------

test('it writes a completed footer and includes logFilePath in the completed event', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toContain('=== Session End ===');
  expect(content).toContain('Outcome:  completed');
  expect(content).toContain('Finished:');

  const completed = ctx.events.find((e) => e.type === 'agentCompleted') as AgentCompletedEvent;
  expect(completed.logFilePath).toBe(`/test-logs/${files[0]}`);
});

test('it writes a failed footer and includes logFilePath in the failed event', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildErrorResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toContain('Outcome:  failed');

  const failed = ctx.events.find((e) => e.type === 'agentFailed') as AgentFailedEvent;
  expect(failed.logFilePath).toBe(`/test-logs/${files[0]}`);
});

test('it writes a cancelled footer when an agent session is cancelled', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.manager.cancelAgent(42);
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toContain('Outcome:  cancelled');

  const failed = ctx.events.find((e) => e.type === 'agentFailed') as AgentFailedEvent;
  expect(failed.logFilePath).toBe(`/test-logs/${files[0]}`);
});

test('it does not include logFilePath in events when logging is disabled', async () => {
  vol.reset();
  const ctx = setupTest({ loggingEnabled: false });

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const completed = ctx.events.find((e) => e.type === 'agentCompleted') as AgentCompletedEvent;
  expect(completed).not.toHaveProperty('logFilePath');
});

// ---------------------------------------------------------------------------
// Session logging — result message formatting
// ---------------------------------------------------------------------------

test('it logs result message metadata in the log file', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toContain('RESULT success');
  expect(content).toContain('Duration: 1.0s');
  expect(content).toContain('Cost:     $0.01');
  expect(content).toContain('Turns:    5');
  expect(content).toContain('Tokens:   100 in / 200 out');
});

// ---------------------------------------------------------------------------
// Session logging — concurrent sessions
// ---------------------------------------------------------------------------

test('it writes to independent log files when two agents run concurrently', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 1 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-a'));
  await drain();

  ctx.manager.dispatchReviewer({ issueNumber: 2 });
  ctx.mockQueries[1]!.pushMessage(buildInitMessage('session-b'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('Output from agent 1'));
  ctx.mockQueries[1]!.pushMessage(buildAssistantMessage('Output from agent 2'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  ctx.mockQueries[1]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[1]!.end();
  await drain();

  const files = readLogFiles();
  expect(files).toHaveLength(2);

  const content1 = readLogContent(files.find((f) => f.includes('-1.log'))!);
  const content2 = readLogContent(files.find((f) => f.includes('-2.log'))!);

  expect(content1).toContain('Output from agent 1');
  expect(content1).not.toContain('Output from agent 2');
  expect(content2).toContain('Output from agent 2');
  expect(content2).not.toContain('Output from agent 1');
});

// ---------------------------------------------------------------------------
// Session logging — error handling
// ---------------------------------------------------------------------------

test('it continues the agent session when the log file cannot be created', async () => {
  vol.reset();
  // Make the logs dir path a file so mkdir fails
  vol.mkdirSync('/bad-path', { recursive: true });
  vol.writeFileSync('/bad-path/logs', 'blocker');

  const ctx = setupTest({ loggingEnabled: true, logsDir: '/bad-path/logs' });

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  // Agent should still complete normally
  const completed = ctx.events.find((e) => e.type === 'agentCompleted') as AgentCompletedEvent;
  expect(completed).toBeDefined();
  expect(completed).not.toHaveProperty('logFilePath');
});

test('it includes logFilePath pointing to the partial file when a write fails mid-session', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  // Find the log file and make it read-only to cause write failures
  const files = readLogFiles();
  const logPath = `/test-logs/${files[0]}`;

  // Remove the file and replace the directory with something that blocks writes
  const originalContent = vol.readFileSync(logPath, 'utf-8');
  vol.unlinkSync(logPath);
  // Re-create as a directory to cause appendFile to fail
  vol.mkdirSync(logPath, { recursive: true });

  ctx.mockQueries[0]!.pushMessage(buildAssistantMessage('This write will fail'));
  await drain();

  // The logger should now be disabled, but agent continues
  ctx.mockQueries[0]!.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]!.end();
  await drain();

  const completed = ctx.events.find((e) => e.type === 'agentCompleted') as AgentCompletedEvent;
  expect(completed).toBeDefined();
  // logFilePath should still point to the partial file path even though it's now a directory
  expect(completed.logFilePath).toBe(logPath);
});

// ---------------------------------------------------------------------------
// Session logging — reviewer log file naming
// ---------------------------------------------------------------------------

test('it names reviewer log files with the issue number as context', async () => {
  const ctx = setupLoggingTest();

  ctx.manager.dispatchReviewer({ issueNumber: 7 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-r'));
  await drain();

  const files = readLogFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d+-reviewer-7\.log$/);

  const content = readLogContent(files[0]!);
  expect(content).toContain('Type:       reviewer');
  expect(content).toContain('Issue:      #7');
});

// ---------------------------------------------------------------------------
// Session logging — init message details
// ---------------------------------------------------------------------------

test('it logs model, working directory, and tools from the init message', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({ issueNumber: 42 });
  ctx.mockQueries[0]!.pushMessage(buildInitMessage('session-1'));
  await drain();

  const files = readLogFiles();
  const content = readLogContent(files[0]!);
  expect(content).toContain('Model: claude-opus-4-6');
  expect(content).toContain('CWD: /repo');
});
