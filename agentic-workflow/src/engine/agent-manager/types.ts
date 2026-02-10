import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStream, AgentType } from '../../types.ts';
import type { EventEmitter } from '../event-emitter/types.ts';
import type { WorktreeManager } from '../worktree-manager/types.ts';

export interface QueryFactoryConfig {
  repoRoot: string;
  bashValidatorHook: HookCallback;
  contextPaths: string[];
}

export type AgentQuery = AsyncIterable<unknown> & {
  interrupt: () => Promise<void>;
};

export interface AgentSessionTracker {
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
}

export type OutputListener = (chunk: string) => void;

export type QueryFactory = (params: QueryFactoryParams) => Promise<AgentQuery>;

export interface QueryFactoryParams {
  prompt: string;
  agent: string;
  cwd: string;
  abortController: AbortController;
  modelOverride?: 'sonnet' | 'opus' | 'haiku';
}

export type LogError = (message: string, error: unknown) => void;

export interface AgentManagerDeps {
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
}

export interface DispatchImplementorParams {
  issueNumber: number;
}

export interface DispatchReviewerParams {
  issueNumber: number;
}

export interface DispatchPlannerParams {
  specPaths: string[];
  prompt?: string;
}

export interface AgentManager {
  dispatchImplementor: (params: DispatchImplementorParams) => Promise<void>;
  dispatchReviewer: (params: DispatchReviewerParams) => Promise<void>;
  dispatchPlanner: (params: DispatchPlannerParams) => Promise<void>;
  cancelAgent: (issueNumber: number) => void;
  cancelPlanner: () => void;
  getAgentStream: (issueNumber: number) => AgentStream;
  isRunning: (issueNumber: number) => boolean;
  isPlannerRunning: () => boolean;
  getRunningSessionIDs: () => string[];
  cancelAll: () => void;
}
