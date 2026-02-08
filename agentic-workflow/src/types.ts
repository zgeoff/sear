// ---------------------------------------------------------------------------
// Engine Events
// ---------------------------------------------------------------------------

export type IssueStatusChangedEvent = {
  type: 'issueStatusChanged';
  issueNumber: number;
  title: string;
  oldStatus: string | null; // null on first detection
  newStatus: string;
  priorityLabel: string;
  createdAt: string; // ISO 8601
  isRecovery?: boolean; // true when emitted as synthetic event from crash recovery
};

export type SpecChangedEvent = {
  type: 'specChanged';
  filePath: string;
  frontmatterStatus: string;
  commitSHA: string; // HEAD commit on default branch (for diff URLs)
};

export type AgentType = 'planner' | 'implementor' | 'reviewer';

export type AgentStartedEvent = {
  type: 'agentStarted';
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner
  sessionID: string;
};

export type AgentCompletedEvent = {
  type: 'agentCompleted';
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  sessionID: string;
};

export type AgentFailedEvent = {
  type: 'agentFailed';
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  error: string;
  sessionID: string;
  worktreePath?: string; // present for Implementor
};

export type AgentSkippedEvent = {
  type: 'agentSkipped';
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner (deferred paths)
};

export type DispatchReadyEvent = {
  type: 'dispatchReady';
  issueNumber: number;
  statusLabel: string;
};

export type NotificationEvent = {
  type: 'notification';
  issueNumber: number;
  statusLabel: string;
  clipboardCommand?: string; // present for needs-refinement, absent for blocked and approved
  contextURL: string; // issue URL for needs-refinement/blocked; issue URL initially for approved (async PR URL update by TUI)
  resolutionGuidance?: string; // present for blocked and needs-refinement, absent for approved
};

export type NotificationDismissedEvent = {
  type: 'notificationDismissed';
  issueNumber: number;
};

export type IssueRemovedEvent = {
  type: 'issueRemoved';
  issueNumber: number;
};

export type RecoveryPerformedEvent = {
  type: 'recoveryPerformed';
  issueNumber: number;
  oldStatus: string;
  newStatus: string;
};

export type EngineEvent =
  | IssueStatusChangedEvent
  | SpecChangedEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentSkippedEvent
  | DispatchReadyEvent
  | NotificationEvent
  | NotificationDismissedEvent
  | IssueRemovedEvent
  | RecoveryPerformedEvent;

// ---------------------------------------------------------------------------
// Engine Commands
// ---------------------------------------------------------------------------

export type DispatchImplementorCommand = {
  command: 'dispatchImplementor';
  issueNumber: number;
};

export type DispatchReviewerCommand = {
  command: 'dispatchReviewer';
  issueNumber: number;
};

export type CancelAgentCommand = {
  command: 'cancelAgent';
  issueNumber: number;
};

export type CancelPlannerCommand = {
  command: 'cancelPlanner';
};

export type ShutdownCommand = {
  command: 'shutdown';
};

export type EngineCommand =
  | DispatchImplementorCommand
  | DispatchReviewerCommand
  | CancelAgentCommand
  | CancelPlannerCommand
  | ShutdownCommand;

// ---------------------------------------------------------------------------
// Query Results
// ---------------------------------------------------------------------------

export type IssueDetailsResult = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string; // ISO 8601
};

export type PRDetailsResult = {
  number: number;
  title: string;
  changedFilesCount: number;
  ciStatus: 'pending' | 'success' | 'failure';
  url: string;
} | null;

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

// getAgentStream returns null if no agent is running for the issue
export type AgentStream = AsyncIterable<string> | null;

// ---------------------------------------------------------------------------
// SpecPoller Batch Result
// ---------------------------------------------------------------------------

export type SpecChange = {
  filePath: string;
  frontmatterStatus: string;
};

export type SpecPollerBatchResult = {
  changes: SpecChange[];
  commitSHA: string; // HEAD commit on default branch (for diff URLs)
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type IssuePollerConfig = {
  pollInterval?: number; // seconds, default: 30
};

export type SpecPollerConfig = {
  pollInterval?: number; // seconds, default: 60
  specsDir?: string; // default: 'docs/specs/'
  defaultBranch?: string; // default: 'main'
};

export type AgentsConfig = {
  agentFilePlanner?: string; // default: '.claude/agents/planner.md'
  agentFileImplementor?: string; // default: '.claude/agents/implementor.md'
  agentFileReviewer?: string; // default: '.claude/agents/reviewer.md'
  maxAgentDuration?: number; // seconds, default: 1800
};

export type EngineConfig = {
  repository: string; // owner/repo format
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel?: 'debug' | 'info' | 'error'; // default: 'info'
  shutdownTimeout?: number; // seconds, default: 300
  issuePoller?: IssuePollerConfig;
  specPoller?: SpecPollerConfig;
  agents?: AgentsConfig;
};

// ---------------------------------------------------------------------------
// Engine Interface
// ---------------------------------------------------------------------------

export type StartupResult = {
  issueCount: number;
  recoveriesPerformed: number;
};

export type Engine = {
  start(): Promise<StartupResult>; // resolves after startup recovery + first IssuePoller and SpecPoller cycles complete
  on(handler: (event: EngineEvent) => void): () => void; // returns unsubscribe function
  send(command: EngineCommand): void;
  getIssueDetails(issueNumber: number): Promise<IssueDetailsResult>;
  getPRForIssue(issueNumber: number): Promise<PRDetailsResult>;
  getAgentStream(issueNumber: number): AgentStream;
};
