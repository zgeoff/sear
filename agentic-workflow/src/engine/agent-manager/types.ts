import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStream, AgentType } from '../../types';
import type { EventEmitter } from '../event-emitter/types';
import type { WorktreeManager } from '../worktree-manager/types';

export type QueryFactoryConfig = {
  repoRoot: string;
  bashValidatorHook: HookCallback;
};

export type AgentQuery = AsyncIterable<unknown> & {
  interrupt(): Promise<void>;
};

export type AgentSessionTracker = {
  agentType: AgentType;
  sessionID: string;
  query: AgentQuery;
  abortController: AbortController;
  timer: ReturnType<typeof setTimeout>;
  worktreePath?: string;
  issueNumber?: number;
  specPaths?: string[];
  outputChunks: string[];
  outputListeners: Set<OutputListener>;
  done: boolean;
};

export type OutputListener = (chunk: string) => void;

export type QueryFactory = (params: QueryFactoryParams) => Promise<AgentQuery>;

export type QueryFactoryParams = {
  prompt: string;
  agent: string;
  cwd: string;
  abortController: AbortController;
};

export type LogError = (message: string, error: unknown) => void;

export type AgentManagerDeps = {
  emitter: EventEmitter;
  worktreeManager: WorktreeManager;
  repoRoot: string;
  agentPlanner: string;
  agentImplementor: string;
  agentReviewer: string;
  maxAgentDuration: number;
  queryFactory: QueryFactory;
  loggingEnabled: boolean;
  logsDir: string;
  logError: LogError;
};

export type DispatchImplementorParams = {
  issueNumber: number;
};

export type DispatchReviewerParams = {
  issueNumber: number;
};

export type DispatchPlannerParams = {
  specPaths: string[];
};

export type AgentManager = {
  dispatchImplementor(params: DispatchImplementorParams): Promise<void>;
  dispatchReviewer(params: DispatchReviewerParams): Promise<void>;
  dispatchPlanner(params: DispatchPlannerParams): Promise<void>;
  cancelAgent(issueNumber: number): void;
  cancelPlanner(): void;
  getAgentStream(issueNumber: number): AgentStream;
  isRunning(issueNumber: number): boolean;
  isPlannerRunning(): boolean;
  getRunningSessionIDs(): string[];
  cancelAll(): void;
};
