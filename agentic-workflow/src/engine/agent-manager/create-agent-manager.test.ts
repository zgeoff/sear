import { vol } from 'memfs';
import invariant from 'tiny-invariant';
import { expect, test, vi } from 'vitest';
import type { EngineEvent } from '../../types.ts';
import { createEventEmitter } from '../event-emitter/create-event-emitter.ts';
import type { WorktreeManager } from '../worktree-manager/types.ts';
import { createAgentManager } from './create-agent-manager.ts';
import type { AgentManager, AgentQuery, QueryFactoryParams } from './types.ts';

// ---------------------------------------------------------------------------
// Top-level regex patterns (useTopLevelRegex)
// ---------------------------------------------------------------------------

const IMPLEMENTOR_LOG_PATTERN = /^\d+-implementor-42\.log$/;
const PLANNER_LOG_PATTERN = /^\d+-planner\.log$/;
const REVIEWER_LOG_PATTERN = /^\d+-reviewer-7\.log$/;
const ASSISTANT_TEXT_PATTERN = /\[\d{2}:\d{2}:\d{2}\] ASSISTANT\n {2}Let me read the spec\./;
const UNKNOWN_MSG_PATTERN = /\[\d{2}:\d{2}:\d{2}\] UNKNOWN user/;

type MockQuery = AgentQuery &
  AsyncIterator<unknown> & {
    pushMessage: (msg: unknown) => void;
    end: () => void;
  };

function createMockQuery(): MockQuery {
  const pendingReads: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
  }> = [];
  const bufferedMessages: unknown[] = [];
  let ended = false;

  const mockQuery: MockQuery = {
    pushMessage(msg: unknown): void {
      if (pendingReads.length > 0) {
        const pending = pendingReads.shift();
        if (pending) {
          pending.resolve({ value: msg, done: false });
        }
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

function createMockWorktreeManager(): WorktreeManager {
  return {
    createOrReuse: vi.fn().mockResolvedValue({
      worktreePath: '/repo/.worktrees/issue-42-1700000000',
      branch: 'issue-42',
      created: true,
    }),
    createForBranch: vi
      .fn()
      .mockImplementation((params: { branchName: string; branchBase?: string }) =>
        Promise.resolve({
          worktreePath: `/repo/.worktrees/${params.branchName}`,
          branch: params.branchName,
          created: params.branchBase !== undefined,
        }),
      ),
    remove: vi.fn().mockResolvedValue(undefined),
    removeByPath: vi.fn().mockResolvedValue(undefined),
  };
}

interface SetupContext {
  manager: AgentManager;
  emitter: ReturnType<typeof createEventEmitter>;
  worktreeManager: WorktreeManager;
  events: EngineEvent[];
  mockQueries: MockQuery[];
  queryParams: QueryFactoryParams[];
  execCommandCalls: Array<{ cwd: string; command: string; args: string[] }>;
  logInfoCalls: string[];
}

interface SetupOverrides {
  maxAgentDuration?: number;
  loggingEnabled?: boolean;
  logsDir?: string;
  execCommandShouldFail?: boolean;
}

function setupTest(overrides?: SetupOverrides): SetupContext {
  const emitter = createEventEmitter();
  const worktreeManager = createMockWorktreeManager();
  const events: EngineEvent[] = [];
  const mockQueries: MockQuery[] = [];
  const queryParams: QueryFactoryParams[] = [];
  const execCommandCalls: Array<{ cwd: string; command: string; args: string[] }> = [];
  const logInfoCalls: string[] = [];

  emitter.on((event) => {
    events.push(event);
  });

  const queryFactory: (params: QueryFactoryParams) => Promise<MockQuery> = async (
    params: QueryFactoryParams,
  ) => {
    queryParams.push(params);
    const mockQuery = createMockQuery();
    mockQueries.push(mockQuery);
    return mockQuery;
  };

  const execCommand = async (cwd: string, command: string, args: string[]): Promise<void> => {
    execCommandCalls.push({ cwd, command, args });
    if (overrides?.execCommandShouldFail === true) {
      throw new Error('yarn install failed');
    }
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
    logError: () => {
      // Intentionally empty — suppress error logging in tests
    },
    logInfo: (message: string) => {
      logInfoCalls.push(message);
    },
    execCommand,
  });

  return {
    manager,
    emitter,
    worktreeManager,
    events,
    mockQueries,
    queryParams,
    execCommandCalls,
    logInfoCalls,
  };
}

function buildInitMessage(sessionId: string): {
  type: 'system';
  subtype: 'init';
  session_id: string;
  uuid: string;
  agents: never[];
  apiKeySource: 'user';
  cwd: string;
  tools: never[];
  mcp_servers: never[];
  model: string;
  permissionMode: 'bypassPermissions';
  slash_commands: never[];
  output_style: string;
} {
  return {
    type: 'system' as const,
    subtype: 'init' as const,
    session_id: sessionId,
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

function buildAssistantMessage(text: string): {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: { content: Array<{ type: 'text'; text: string }> };
  parent_tool_use_id: null;
} {
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

function buildSuccessResult(): {
  type: 'result';
  subtype: 'success';
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: false;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  modelUsage: Record<string, never>;
  permission_denials: never[];
} {
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

function buildErrorResult(): {
  type: 'result';
  subtype: 'error_during_execution';
  uuid: string;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  is_error: true;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  modelUsage: Record<string, never>;
  permission_denials: never[];
} {
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

// ---------------------------------------------------------------------------
// Implementor dispatch
// ---------------------------------------------------------------------------

test('it creates a worktree and agent session when dispatching an implementor', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
  });
  expect(ctx.mockQueries).toHaveLength(1);
  expect(ctx.queryParams[0]).toMatchObject({
    prompt: 'enriched implementor prompt for #42',
    agent: 'implementor',
    cwd: '/repo/.worktrees/issue-42-1700000000',
  });
});

test('it logs at info level and skips dispatch when an implementor is already running for the issue', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.mockQueries).toHaveLength(1);
  expect(ctx.logInfoCalls.some((m) => m.includes('implementor') && m.includes('#42'))).toBe(true);
});

test('it emits agentStarted with session ID and branch name when the init message is received', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('abc-123'));
  await vi.waitFor(() => {
    const started = ctx.events.find((e) => e.type === 'agentStarted');
    expect(started).toStrictEqual({
      type: 'agentStarted',
      agentType: 'implementor',
      issueNumber: 42,
      sessionID: 'abc-123',
      branchName: 'issue-42-1700000000',
    });
  });
});

test('it sets the working directory to the worktree path for implementors', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.queryParams[0]).toMatchObject({
    cwd: '/repo/.worktrees/issue-42-1700000000',
  });
});

test('it emits agentCompleted and removes worktree when an implementor session succeeds', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    const completed = ctx.events.find((e) => e.type === 'agentCompleted');
    expect(completed).toStrictEqual({
      type: 'agentCompleted',
      agentType: 'implementor',
      issueNumber: 42,
      sessionID: 'session-1',
    });
  });

  expect(ctx.worktreeManager.removeByPath).toHaveBeenCalledWith(
    '/repo/.worktrees/issue-42-1700000000',
  );
  expect(ctx.manager.isRunning(42)).toBe(false);
});

test('it emits agentFailed with branch name when an implementor session fails', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildErrorResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    const failed = ctx.events.find((e) => e.type === 'agentFailed');
    expect(failed).toStrictEqual({
      type: 'agentFailed',
      agentType: 'implementor',
      issueNumber: 42,
      error: 'Agent session ended with error',
      sessionID: 'session-1',
      branchName: 'issue-42-1700000000',
    });
  });

  expect(ctx.worktreeManager.removeByPath).toHaveBeenCalledWith(
    '/repo/.worktrees/issue-42-1700000000',
  );
});

// ---------------------------------------------------------------------------
// Yarn install step
// ---------------------------------------------------------------------------

test('it runs yarn install in the worktree after creating it for implementors', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.execCommandCalls).toHaveLength(1);
  expect(ctx.execCommandCalls[0]).toStrictEqual({
    cwd: '/repo/.worktrees/issue-42-1700000000',
    command: 'yarn',
    args: ['install'],
  });
});

test('it removes the worktree and emits agentFailed when yarn install fails for implementors', async () => {
  const ctx = setupTest({ execCommandShouldFail: true });

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.worktreeManager.removeByPath).toHaveBeenCalledWith(
    '/repo/.worktrees/issue-42-1700000000',
  );
  expect(ctx.mockQueries).toHaveLength(0);
  expect(ctx.events).toContainEqual({
    type: 'agentFailed',
    agentType: 'implementor',
    issueNumber: 42,
    sessionID: '',
    error: 'yarn install failed',
    branchName: 'issue-42-1700000000',
  });
});

test('it creates the agent session when yarn install succeeds for implementors', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.mockQueries).toHaveLength(1);
  expect(ctx.queryParams[0]).toMatchObject({
    prompt: 'enriched implementor prompt for #42',
    agent: 'implementor',
    cwd: '/repo/.worktrees/issue-42-1700000000',
  });
});

// ---------------------------------------------------------------------------
// Reviewer dispatch
// ---------------------------------------------------------------------------

test('it creates a worktree and sets the working directory for reviewers', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-10-branch',
  });
  expect(ctx.queryParams[0]).toMatchObject({
    prompt: 'enriched prompt',
    agent: 'reviewer',
    cwd: '/repo/.worktrees/issue-10-branch',
  });
});

test('it logs at info level and skips dispatch when a reviewer is dispatched for an issue with a running agent', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 10,
    branchName: 'issue-10-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #10',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.mockQueries).toHaveLength(1);

  expect(ctx.logInfoCalls.some((m) => m.includes('reviewer') && m.includes('#10'))).toBe(true);
});

test('it passes the enriched prompt as the initial prompt for reviewers', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 7,
    branchName: 'issue-7-branch',
    prompt: '7',
  });

  expect(ctx.queryParams[0]).toMatchObject({
    prompt: '7',
  });
});

test('it emits agentCompleted and removes worktree for reviewer sessions', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-branch',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-r'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    const completed = ctx.events.find((e) => e.type === 'agentCompleted');
    expect(completed).toStrictEqual({
      type: 'agentCompleted',
      agentType: 'reviewer',
      issueNumber: 10,
      sessionID: 'session-r',
    });
  });

  expect(ctx.worktreeManager.removeByPath).toHaveBeenCalledWith('/repo/.worktrees/issue-10-branch');
});

test('it emits agentStarted with branch name for reviewer sessions', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-r'));
  await vi.waitFor(() => {
    const started = ctx.events.find((e) => e.type === 'agentStarted');
    expect(started).toStrictEqual({
      type: 'agentStarted',
      agentType: 'reviewer',
      issueNumber: 10,
      sessionID: 'session-r',
      branchName: 'issue-10-pr-branch',
    });
  });
});

// ---------------------------------------------------------------------------
// Reviewer worktree: remote fetch
// ---------------------------------------------------------------------------

test('it passes fetchRemote to the worktree manager when dispatching a reviewer with fetchRemote true', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
    fetchRemote: true,
    prompt: 'enriched prompt',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-10-pr-branch',
    fetchRemote: true,
  });
  expect(ctx.queryParams[0]).toMatchObject({
    cwd: '/repo/.worktrees/issue-10-pr-branch',
  });
});

test('it does not pass fetchRemote to the worktree manager when fetchRemote is false', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
    fetchRemote: false,
    prompt: 'enriched prompt',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-10-pr-branch',
  });
});

test('it does not pass fetchRemote to the worktree manager when fetchRemote is not provided', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-10-pr-branch',
  });
});

test('it removes the reviewer worktree on failure', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
    fetchRemote: true,
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-r'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildErrorResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentFailed')).toBe(true);
  });

  expect(ctx.worktreeManager.removeByPath).toHaveBeenCalledWith(
    '/repo/.worktrees/issue-10-pr-branch',
  );
});

test('it runs yarn install in the worktree after creating it for reviewers', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.execCommandCalls).toHaveLength(1);
  expect(ctx.execCommandCalls[0]).toStrictEqual({
    cwd: '/repo/.worktrees/issue-10-branch',
    command: 'yarn',
    args: ['install'],
  });
});

test('it removes the worktree and emits agentFailed when yarn install fails for reviewers', async () => {
  const ctx = setupTest({ execCommandShouldFail: true });

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.worktreeManager.removeByPath).toHaveBeenCalledWith('/repo/.worktrees/issue-10-branch');
  expect(ctx.mockQueries).toHaveLength(0);
  expect(ctx.events).toContainEqual({
    type: 'agentFailed',
    agentType: 'reviewer',
    issueNumber: 10,
    sessionID: '',
    error: 'yarn install failed',
    branchName: 'issue-10-branch',
  });
});

test('it creates the agent session when yarn install succeeds for reviewers', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.mockQueries).toHaveLength(1);
  expect(ctx.queryParams[0]).toMatchObject({
    prompt: 'enriched prompt',
    agent: 'reviewer',
    cwd: '/repo/.worktrees/issue-10-branch',
  });
});

// ---------------------------------------------------------------------------
// Planner dispatch
// ---------------------------------------------------------------------------

test('it sets the working directory to the repo root for planners', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });

  expect(ctx.queryParams[0]).toMatchObject({
    agent: 'planner',
    cwd: '/repo',
  });
});

test('it passes spec paths space-separated as the initial prompt for planners', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md', 'docs/specs/b.md'] });

  expect(ctx.queryParams[0]).toMatchObject({
    prompt: 'docs/specs/a.md docs/specs/b.md',
  });
});

test('it logs at info level and skips dispatch when a planner is already running', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/b.md'] });

  expect(ctx.mockQueries).toHaveLength(1);

  expect(ctx.logInfoCalls.some((m) => m.includes('planner'))).toBe(true);
});

test('it emits agentCompleted for planner sessions', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    const completed = ctx.events.find((e) => e.type === 'agentCompleted');
    expect(completed).toStrictEqual({
      type: 'agentCompleted',
      agentType: 'planner',
      specPaths: ['docs/specs/a.md'],
      sessionID: 'session-p',
    });
  });

  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

test('it does not include branchName in agentStarted events for planner sessions', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const started = ctx.events.find((e) => e.type === 'agentStarted');
  expect(started).not.toHaveProperty('branchName');
});

// ---------------------------------------------------------------------------
// Planner streams are accessible by session ID
// ---------------------------------------------------------------------------

test('it returns an async iterable from getAgentStream for a running planner session', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('planner-session-1'));
  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Planning output'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const stream = ctx.manager.getAgentStream('planner-session-1');
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  invariant(stream, 'stream must exist for a running planner');
  const readPromise = (async () => {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  })();

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await readPromise;

  expect(chunks).toStrictEqual(['Planning output']);
});

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

test('it cancels a running agent session and emits agentFailed', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.cancelAgent(42);
  await vi.waitFor(() => {
    const failed = ctx.events.find((e) => e.type === 'agentFailed');
    expect(failed).toMatchObject({
      type: 'agentFailed',
      agentType: 'implementor',
      issueNumber: 42,
      error: 'Cancelled by user',
      sessionID: 'session-1',
      branchName: 'issue-42-1700000000',
    });
  });

  expect(ctx.manager.isRunning(42)).toBe(false);
});

test('it is a no-op when cancelling an agent for an issue with no running session', async () => {
  const ctx = setupTest();

  await ctx.manager.cancelAgent(99);

  expect(ctx.events).toHaveLength(0);
});

test('it cancels a running planner session and emits agentFailed', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.cancelPlanner();
  await vi.waitFor(() => {
    const failed = ctx.events.find((e) => e.type === 'agentFailed');
    expect(failed).toMatchObject({
      type: 'agentFailed',
      agentType: 'planner',
      error: 'Cancelled by user',
      sessionID: 'session-p',
      specPaths: ['docs/specs/a.md'],
    });
  });

  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

test('it is a no-op when cancelling the planner with no running session', async () => {
  const ctx = setupTest();

  await ctx.manager.cancelPlanner();

  expect(ctx.events).toHaveLength(0);
});

test('it completes the async iterable when an agent session is cancelled', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Hello'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const stream = ctx.manager.getAgentStream('session-1');
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  invariant(stream, 'stream must exist for a running agent');
  const streamPromise = (async () => {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  })();

  await ctx.manager.cancelAgent(42);

  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentFailed')).toBe(true);
  });

  await streamPromise;
  expect(chunks).toContain('Hello');
});

// ---------------------------------------------------------------------------
// Stream accessor
// ---------------------------------------------------------------------------

test('it returns null from getAgentStream when no agent session exists for the given session ID', () => {
  const ctx = setupTest();

  expect(ctx.manager.getAgentStream('nonexistent-session')).toBeNull();
});

test('it returns null from getAgentStream after the agent session completes', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Hello world'));
  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('More output'));
  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    // After completion, stream returns null since agent is no longer running
    const stream = ctx.manager.getAgentStream('session-1');
    expect(stream).toBeNull();
  });
});

test('it yields buffered and live chunks through the async iterable', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Chunk 1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const stream = ctx.manager.getAgentStream('session-1');
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  invariant(stream, 'stream must exist for a running agent');
  const readPromise = (async () => {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  })();

  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Chunk 2'));
  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await readPromise;

  expect(chunks).toStrictEqual(['Chunk 1', 'Chunk 2']);
});

// ---------------------------------------------------------------------------
// Duration timeout
// ---------------------------------------------------------------------------

test('it cancels a session that exceeds the max duration', async () => {
  vi.useFakeTimers();

  const ctx = setupTest({ maxAgentDuration: 10 });

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));

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
  expect(failed).toMatchObject({
    error: expect.stringContaining('exceeded max duration'),
  });
  expect(ctx.manager.isRunning(42)).toBe(false);
});

// ---------------------------------------------------------------------------
// Tracking queries
// ---------------------------------------------------------------------------

test('it tracks whether an agent is running for a given issue', async () => {
  const ctx = setupTest();

  expect(ctx.manager.isRunning(42)).toBe(false);

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.manager.isRunning(42)).toBe(true);

  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.manager.isRunning(42)).toBe(false);
  });
});

test('it tracks whether a planner is running', async () => {
  const ctx = setupTest();

  expect(ctx.manager.isPlannerRunning()).toBe(false);

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });

  expect(ctx.manager.isPlannerRunning()).toBe(true);

  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.manager.isPlannerRunning()).toBe(false);
  });
});

test('it returns all running session IDs', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 1,
    branchName: 'issue-1-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #1',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-impl'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(1);
  });

  await ctx.manager.dispatchReviewer({
    issueNumber: 2,
    branchName: 'issue-2-branch',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[1]?.pushMessage(buildInitMessage('session-rev'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(2);
  });

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[2]?.pushMessage(buildInitMessage('session-plan'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(3);
  });

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

  await ctx.manager.dispatchImplementor({
    issueNumber: 1,
    branchName: 'issue-1-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #1',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(1);
  });

  await ctx.manager.dispatchReviewer({
    issueNumber: 2,
    branchName: 'issue-2-branch',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[1]?.pushMessage(buildInitMessage('session-2'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(2);
  });

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[2]?.pushMessage(buildInitMessage('session-3'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(3);
  });

  await ctx.manager.cancelAll();
  await vi.waitFor(() => {
    const failures = ctx.events.filter((e) => e.type === 'agentFailed');
    expect(failures).toHaveLength(3);
  });

  expect(ctx.manager.isRunning(1)).toBe(false);
  expect(ctx.manager.isRunning(2)).toBe(false);
  expect(ctx.manager.isPlannerRunning()).toBe(false);
});

// ---------------------------------------------------------------------------
// Session ID is included in failed events
// ---------------------------------------------------------------------------

test('it includes the session ID in the agentFailed event for implementor failures', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('my-session-id'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildErrorResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    const failed = ctx.events.find((e) => e.type === 'agentFailed');
    expect(failed).toMatchObject({
      sessionID: 'my-session-id',
    });
  });
});

// ---------------------------------------------------------------------------
// Does not include worktreePath for non-implementor failures
// ---------------------------------------------------------------------------

test('it includes branchName in agentFailed events for reviewers', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-r'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildErrorResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentFailed')).toBe(true);
  });

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).toMatchObject({
    type: 'agentFailed',
    agentType: 'reviewer',
    issueNumber: 10,
    branchName: 'issue-10-pr-branch',
  });
});

test('it does not include branchName in agentFailed events for planners', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildErrorResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentFailed')).toBe(true);
  });

  const failed = ctx.events.find((e) => e.type === 'agentFailed');
  expect(failed).not.toHaveProperty('branchName');
});

// ---------------------------------------------------------------------------
// Guard: only one agent per issue across types
// ---------------------------------------------------------------------------

test('it logs at info level and skips dispatch when a reviewer is dispatched for an issue already running an implementor', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 5,
    branchName: 'issue-5-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #5',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-impl'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.dispatchReviewer({
    issueNumber: 5,
    branchName: 'issue-5-branch',
    prompt: 'enriched prompt',
  });

  expect(ctx.logInfoCalls.some((m) => m.includes('reviewer') && m.includes('#5'))).toBe(true);
  expect(ctx.mockQueries).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Filters non-text content from assistant messages
// ---------------------------------------------------------------------------

test('it only yields text content from assistant messages and filters out tool use blocks', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  // Message with mixed content including tool_use blocks
  ctx.mockQueries[0]?.pushMessage({
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
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const stream = ctx.manager.getAgentStream('session-1');
  expect(stream).not.toBeNull();

  const chunks: string[] = [];
  invariant(stream, 'stream must exist for a running agent');
  const readPromise = (async () => {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  })();

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await readPromise;

  // The text should be concatenated, tool_use blocks filtered out
  expect(chunks).toStrictEqual(['Let me check that file.']);
});

// ---------------------------------------------------------------------------
// Allows dispatching a new session after the previous one completes
// ---------------------------------------------------------------------------

test('it allows dispatching a new implementor after the previous one completes', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.manager.isRunning(42)).toBe(false);
  });

  // Should be able to dispatch again
  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
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
    const dir = vol.readdirSync('/test-logs');
    return dir
      .map(String)
      .filter((f) => f.endsWith('.log'))
      .sort();
  } catch {
    return [];
  }
}

function readLogContent(fileName: string): string {
  return String(vol.readFileSync(`/test-logs/${fileName}`, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Session logging — log file creation
// ---------------------------------------------------------------------------

test('it creates a log file with session header when logging is enabled and an init message is received', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-abc'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const files = readLogFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(IMPLEMENTOR_LOG_PATTERN);

  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).toContain('=== Agent Session ===');
  expect(content).toContain('Type:       implementor');
  expect(content).toContain('Session ID: session-abc');
  expect(content).toContain('Issue:      #42');
  expect(content).toContain('=== Messages ===');
  expect(content).toContain('SYSTEM init');
});

test('it includes logFilePath in agentStarted when logging is enabled', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-abc'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const started = ctx.events.find((e) => e.type === 'agentStarted');
  expect(started).toHaveProperty('logFilePath');
  expect(started).toMatchObject({
    logFilePath: expect.stringContaining('/test-logs/'),
  });
});

test('it does not include logFilePath in agentStarted when logging is disabled', async () => {
  vol.reset();
  const ctx = setupTest({ loggingEnabled: false });

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-abc'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const started = ctx.events.find((e) => e.type === 'agentStarted');
  expect(started).not.toHaveProperty('logFilePath');
});

test('it names planner log files without a context suffix', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchPlanner({ specPaths: ['docs/specs/a.md'] });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-p'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const files = readLogFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(PLANNER_LOG_PATTERN);

  invariant(files[0], 'log file must exist after planner init');
  const content = readLogContent(files[0]);
  expect(content).toContain('Spec Paths: docs/specs/a.md');
});

test('it does not create a log file when logging is disabled', async () => {
  const ctx = setupTest({ loggingEnabled: false, logsDir: '/test-logs' });
  vol.reset();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-abc'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const files = readLogFiles();
  expect(files).toHaveLength(0);
});

test('it creates the logs directory automatically when it does not exist', async () => {
  vol.reset();
  const ctx = setupTest({ loggingEnabled: true, logsDir: '/new-logs-dir' });

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-abc'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const dir = vol.readdirSync('/new-logs-dir');
  expect(dir.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Session logging — message formatting
// ---------------------------------------------------------------------------

test('it appends formatted assistant text messages to the log file', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Let me read the spec.'));
  await vi.waitFor(() => {
    const files = readLogFiles();
    invariant(files[0], 'log file must exist after agent init');
    const content = readLogContent(files[0]);
    expect(content).toMatch(ASSISTANT_TEXT_PATTERN);
  });
});

test('it logs tool use blocks with only the tool name', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage({
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
  await vi.waitFor(() => {
    const files = readLogFiles();
    invariant(files[0], 'log file must exist after agent init');
    const content = readLogContent(files[0]);
    expect(content).toContain('[tool_use] Read');
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).not.toContain('/foo.ts');
});

test('it logs unknown message types with raw JSON', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const userMessage = { type: 'user', content: 'hello' };
  ctx.mockQueries[0]?.pushMessage(userMessage);
  await vi.waitFor(() => {
    const files = readLogFiles();
    invariant(files[0], 'log file must exist after agent init');
    const content = readLogContent(files[0]);
    expect(content).toMatch(UNKNOWN_MSG_PATTERN);
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).toContain(JSON.stringify(userMessage));
});

// ---------------------------------------------------------------------------
// Session logging — footer and logFilePath in events
// ---------------------------------------------------------------------------

test('it writes a completed footer and includes logFilePath in the completed event', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentCompleted')).toBe(true);
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).toContain('=== Session End ===');
  expect(content).toContain('Outcome:  completed');
  expect(content).toContain('Finished:');

  expect(ctx.events).toContainEqual(
    expect.objectContaining({
      type: 'agentCompleted',
      logFilePath: `/test-logs/${files[0]}`,
    }),
  );
});

test('it writes a failed footer and includes logFilePath in the failed event', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildErrorResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentFailed')).toBe(true);
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).toContain('Outcome:  failed');

  expect(ctx.events).toContainEqual(
    expect.objectContaining({
      type: 'agentFailed',
      logFilePath: `/test-logs/${files[0]}`,
    }),
  );
});

test('it writes a cancelled footer when an agent session is cancelled', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  await ctx.manager.cancelAgent(42);
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentFailed')).toBe(true);
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).toContain('Outcome:  cancelled');

  expect(ctx.events).toContainEqual(
    expect.objectContaining({
      type: 'agentFailed',
      logFilePath: `/test-logs/${files[0]}`,
    }),
  );
});

test('it does not include logFilePath in events when logging is disabled', async () => {
  vol.reset();
  const ctx = setupTest({ loggingEnabled: false });

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentCompleted')).toBe(true);
  });

  const completed = ctx.events.find((e) => e.type === 'agentCompleted');
  expect(completed).not.toHaveProperty('logFilePath');
});

// ---------------------------------------------------------------------------
// Session logging — result message formatting
// ---------------------------------------------------------------------------

test('it logs result message metadata in the log file', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentCompleted')).toBe(true);
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
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

  await ctx.manager.dispatchImplementor({
    issueNumber: 1,
    branchName: 'issue-1-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #1',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-a'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(1);
  });

  await ctx.manager.dispatchReviewer({
    issueNumber: 2,
    branchName: 'issue-2-branch',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[1]?.pushMessage(buildInitMessage('session-b'));
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentStarted')).toHaveLength(2);
  });

  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('Output from agent 1'));
  ctx.mockQueries[1]?.pushMessage(buildAssistantMessage('Output from agent 2'));

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  ctx.mockQueries[1]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[1]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.filter((e) => e.type === 'agentCompleted')).toHaveLength(2);
  });

  const files = readLogFiles();
  expect(files).toHaveLength(2);

  const file1 = files.find((f) => f.includes('-1.log'));
  const file2 = files.find((f) => f.includes('-2.log'));
  invariant(file1, 'log file for agent 1 must exist');
  invariant(file2, 'log file for agent 2 must exist');
  const content1 = readLogContent(file1);
  const content2 = readLogContent(file2);

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

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentCompleted')).toBe(true);
  });

  // Agent should still complete normally
  const completed = ctx.events.find((e) => e.type === 'agentCompleted');
  expect(completed).toBeDefined();
  expect(completed).not.toHaveProperty('logFilePath');
});

test('it includes logFilePath pointing to the partial file when a write fails mid-session', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  // Find the log file and make it read-only to cause write failures
  const files = readLogFiles();
  const logPath = `/test-logs/${files[0]}`;

  // Remove the file and replace the directory with something that blocks writes
  const _originalContent = vol.readFileSync(logPath, 'utf-8');
  vol.unlinkSync(logPath);
  // Re-create as a directory to cause appendFile to fail
  vol.mkdirSync(logPath, { recursive: true });

  ctx.mockQueries[0]?.pushMessage(buildAssistantMessage('This write will fail'));

  // The logger should now be disabled, but agent continues
  ctx.mockQueries[0]?.pushMessage(buildSuccessResult());
  ctx.mockQueries[0]?.end();
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentCompleted')).toBe(true);
  });

  expect(ctx.events).toContainEqual(
    expect.objectContaining({
      type: 'agentCompleted',
      logFilePath: logPath,
    }),
  );
});

// ---------------------------------------------------------------------------
// Session logging — reviewer log file naming
// ---------------------------------------------------------------------------

test('it names reviewer log files with the issue number as context', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchReviewer({
    issueNumber: 7,
    branchName: 'issue-7-1700000000',
    prompt: 'enriched prompt',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-r'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const files = readLogFiles();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(REVIEWER_LOG_PATTERN);

  invariant(files[0], 'log file must exist after reviewer init');
  const content = readLogContent(files[0]);
  expect(content).toContain('Type:       reviewer');
  expect(content).toContain('Issue:      #7');
});

// ---------------------------------------------------------------------------
// Session logging — init message details
// ---------------------------------------------------------------------------

test('it logs model, working directory, and tools from the init message', async () => {
  const ctx = setupLoggingTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1700000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });
  ctx.mockQueries[0]?.pushMessage(buildInitMessage('session-1'));
  await vi.waitFor(() => {
    expect(ctx.events.some((e) => e.type === 'agentStarted')).toBe(true);
  });

  const files = readLogFiles();
  invariant(files[0], 'log file must exist after agent init');
  const content = readLogContent(files[0]);
  expect(content).toContain('Model: claude-opus-4-6');
  expect(content).toContain('CWD: /repo');
});

// ---------------------------------------------------------------------------
// Worktree strategy: fresh-branch (no linked PR)
// ---------------------------------------------------------------------------

test('it uses a fresh branch from main when branchBase is provided', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1739000000',
    branchBase: 'main',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-42-1739000000',
    branchBase: 'main',
  });
  expect(ctx.queryParams[0]).toMatchObject({
    cwd: '/repo/.worktrees/issue-42-1739000000',
  });
});

// ---------------------------------------------------------------------------
// Worktree strategy: PR-branch (linked PR exists)
// ---------------------------------------------------------------------------

test('it uses the PR branch when no branchBase is provided', async () => {
  const ctx = setupTest();

  await ctx.manager.dispatchImplementor({
    issueNumber: 42,
    branchName: 'issue-42-1738000000',
    prompt: 'enriched implementor prompt for #42',
  });

  expect(ctx.worktreeManager.createForBranch).toHaveBeenCalledWith({
    branchName: 'issue-42-1738000000',
  });
  expect(ctx.queryParams[0]).toMatchObject({
    cwd: '/repo/.worktrees/issue-42-1738000000',
  });
});
