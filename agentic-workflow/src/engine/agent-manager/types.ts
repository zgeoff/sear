import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStream, AgentType } from '../../types';
import type { EventEmitter } from '../event-emitter/types';
import type { WorktreeManager } from '../worktree-manager/types';

export type AgentSessionTracker = {
  agentType: AgentType;
  sessionID: string;
  query: Query;
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

export type QueryFactory = (params: QueryFactoryParams) => Query;

export type QueryFactoryParams = {
  prompt: string;
  agent: string;
  cwd: string;
  abortController: AbortController;
};

export type AgentManagerDeps = {
  emitter: EventEmitter;
  worktreeManager: WorktreeManager;
  repoRoot: string;
  agentPlanner: string;
  agentImplementor: string;
  agentReviewer: string;
  maxAgentDuration: number;
  queryFactory: QueryFactory;
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
  dispatchReviewer(params: DispatchReviewerParams): void;
  dispatchPlanner(params: DispatchPlannerParams): void;
  cancelAgent(issueNumber: number): void;
  cancelPlanner(): void;
  getAgentStream(issueNumber: number): AgentStream;
  isRunning(issueNumber: number): boolean;
  isPlannerRunning(): boolean;
  getRunningSessionIDs(): string[];
  cancelAll(): void;
};
