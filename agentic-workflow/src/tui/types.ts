import type { Engine, StartupResult } from '../types.ts';

export type TaskAgentType = 'implementor' | 'reviewer';

export interface LastFailure {
  agentType: TaskAgentType;
  error: string;
  sessionID: string;
  branchName?: string;
  logFilePath?: string;
}

export interface TrackedIssue {
  number: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string;
  agentRunning: boolean;
  agentType?: TaskAgentType;
  lastFailure?: LastFailure;
  resolutionGuidance?: string;
}

export interface BaseNotification {
  id: string;
  timestamp: string;
  summary: string;
  contextURL?: string;
  clipboardCommand?: string;
}

export type AgentStartedNotification = BaseNotification & {
  eventType: 'agentStarted';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
  specCount?: number;
};

export type AgentCompletedNotification = BaseNotification & {
  eventType: 'agentCompleted';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
  specCount?: number;
  logFilePath?: string;
};

export type AgentFailedNotification = BaseNotification & {
  eventType: 'agentFailed';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
  error: string;
  sessionID: string;
  logFilePath?: string;
};

export type AgentSkippedNotification = BaseNotification & {
  eventType: 'agentSkipped';
  agentType: 'implementor' | 'reviewer' | 'planner';
  issueNumber?: number;
};

export type IssueStatusChangedNotification = BaseNotification & {
  eventType: 'issueStatusChanged';
  issueNumber: number;
  oldStatus: string | null;
  newStatus: string;
};

export type SpecChangedNotification = BaseNotification & {
  eventType: 'specChanged';
  specFileName: string;
};

export type RecoveryPerformedNotification = BaseNotification & {
  eventType: 'recoveryPerformed';
  issueNumber: number;
};

export type DispatchReadyNotification = BaseNotification & {
  eventType: 'dispatchReady';
  issueNumber: number;
};

export type EngineEventNotification = BaseNotification & {
  eventType: 'notification';
  issueNumber: number;
  notificationType: 'needs-refinement' | 'blocked' | 'approved';
  resolutionGuidance?: string;
};

export type NotificationDismissedNotification = BaseNotification & {
  eventType: 'notificationDismissed';
  issueNumber: number;
};

export type IssueRemovedNotification = BaseNotification & {
  eventType: 'issueRemoved';
  issueNumber: number;
};

export type StartupNotification = BaseNotification & {
  eventType: 'startup';
  issueCount: number;
  recoveriesPerformed: number;
};

export type Notification =
  | AgentStartedNotification
  | AgentCompletedNotification
  | AgentFailedNotification
  | AgentSkippedNotification
  | IssueStatusChangedNotification
  | SpecChangedNotification
  | RecoveryPerformedNotification
  | DispatchReadyNotification
  | EngineEventNotification
  | NotificationDismissedNotification
  | IssueRemovedNotification
  | StartupNotification;

export type FocusedPane = 'issueList' | 'detailPane' | 'notifications';

export interface CachedIssueDetails {
  body: string;
  labels: string[];
  stale: boolean;
}

// CachedPRDetails captures the PRDetailsResult fields needed for TUI display
// (see control-plane-engine.md#query-results), plus a `stale` field for cache
// management. `isDraft` and `headRefName` are omitted — not needed for rendering.
export interface CachedPRDetails {
  number: number;
  title: string;
  changedFilesCount: number;
  ciStatus: 'pending' | 'success' | 'failure';
  url: string;
  stale: boolean;
}

export interface Repository {
  owner: string;
  repo: string;
}

export interface EngineStoreState {
  repository: Repository;
  issues: Map<number, TrackedIssue>;
  notifications: Notification[];
  agentStreams: Map<number, string[]>;
  streamViewportOffsets: Map<number, number>;
  plannerRunning: boolean;
  issueDetails: Map<number, CachedIssueDetails>;
  prDetails: Map<number, CachedPRDetails>;
  prNotFound: Set<number>;
  focusedPane: FocusedPane;
  selectedIssue: number | null;
  shuttingDown: boolean;
}

export interface EngineStoreActions {
  dispatchImplementor: (issueNumber: number) => void;
  dispatchReviewer: (issueNumber: number) => void;
  cancelAgent: (issueNumber: number) => void;
  shutdown: () => void;
  cycleFocus: (direction: 'forward' | 'backward') => void;
  selectIssue: (issueNumber: number) => Promise<void>;
  handleStartup: (result: StartupResult) => void;
}

export type EngineStore = EngineStoreState & EngineStoreActions;

export interface CreateEngineStoreConfig {
  engine: Engine;
  repository: string;
}
