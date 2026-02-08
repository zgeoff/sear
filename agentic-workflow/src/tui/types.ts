import type { Engine } from '../types';

export type TaskAgentType = 'implementor' | 'reviewer';

export type LastFailure = {
  agentType: TaskAgentType;
  error: string;
  sessionID: string;
  worktreePath?: string;
};

export type TrackedIssue = {
  number: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string;
  agentRunning: boolean;
  agentType?: TaskAgentType;
  lastFailure?: LastFailure;
};

export type Notification = {
  id: string;
  timestamp: string;
  eventType: string;
  issueNumber?: number;
  summary: string;
  contextURL?: string;
  clipboardCommand?: string;
};

export type FocusedPane = 'issueList' | 'detailPane' | 'notifications';

export type CachedIssueDetails = {
  body: string;
  labels: string[];
  stale: boolean;
};

export type CachedPRDetails = {
  number: number;
  title: string;
  changedFilesCount: number;
  ciStatus: 'pending' | 'success' | 'failure';
  url: string;
  stale: boolean;
};

export type EngineStoreState = {
  issues: Map<number, TrackedIssue>;
  notifications: Notification[];
  agentStreams: Map<number, string[]>;
  plannerRunning: boolean;
  issueDetails: Map<number, CachedIssueDetails>;
  prDetails: Map<number, CachedPRDetails>;
  focusedPane: FocusedPane;
  selectedIssue: number | null;
  shuttingDown: boolean;
};

export type EngineStoreActions = {
  dispatchImplementor: (issueNumber: number) => void;
  dispatchReviewer: (issueNumber: number) => void;
  cancelAgent: (issueNumber: number) => void;
  shutdown: () => void;
  cycleFocus: (direction: 'forward' | 'backward') => void;
  selectIssue: (issueNumber: number) => void;
};

export type EngineStore = EngineStoreState & EngineStoreActions;

export type CreateEngineStoreConfig = {
  engine: Engine;
  repository: string;
};
