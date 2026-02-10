// ---------------------------------------------------------------------------
// Engine Events
// ---------------------------------------------------------------------------

export interface IssueStatusChangedEvent {
  type: 'issueStatusChanged';
  issueNumber: number;
  title: string;
  oldStatus: string | null; // null on first detection
  newStatus: string;
  priorityLabel: string;
  createdAt: string; // ISO 8601
  isRecovery?: boolean; // true when emitted as synthetic event from crash recovery
}

export interface SpecChangedEvent {
  type: 'specChanged';
  filePath: string;
  frontmatterStatus: string;
  changeType: 'added' | 'modified';
  commitSHA: string; // Always non-empty — events are only emitted when changes are detected. HEAD commit on default branch (for diff URLs).
}

export type AgentType = 'planner' | 'implementor' | 'reviewer';

export interface AgentStartedEvent {
  type: 'agentStarted';
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner
  sessionID: string;
}

export interface AgentCompletedEvent {
  type: 'agentCompleted';
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  sessionID: string;
  logFilePath?: string; // present when logging.agentSessions is enabled
}

export interface AgentFailedEvent {
  type: 'agentFailed';
  agentType: AgentType;
  issueNumber?: number;
  specPaths?: string[];
  error: string;
  sessionID: string;
  worktreePath?: string; // present for Implementor
  logFilePath?: string; // present when logging.agentSessions is enabled
}

export interface AgentSkippedEvent {
  type: 'agentSkipped';
  agentType: AgentType;
  issueNumber?: number; // present for Implementor, Reviewer
  specPaths?: string[]; // present for Planner (deferred paths)
}

export interface DispatchReadyEvent {
  type: 'dispatchReady';
  issueNumber: number;
  statusLabel: string;
}

export interface NotificationEvent {
  type: 'notification';
  issueNumber: number;
  statusLabel: string;
  clipboardCommand?: string; // present for needs-refinement, absent for blocked and approved
  contextURL: string; // issue URL for needs-refinement/blocked; issue URL initially for approved (async PR URL update by TUI)
  resolutionGuidance?: string; // The engine guarantees this is always present when statusLabel is 'needs-refinement' or 'blocked'; absent only for 'approved'.
}

export interface NotificationDismissedEvent {
  type: 'notificationDismissed';
  issueNumber: number;
}

export interface IssueRemovedEvent {
  type: 'issueRemoved';
  issueNumber: number;
}

export interface RecoveryPerformedEvent {
  type: 'recoveryPerformed';
  issueNumber: number;
  oldStatus: string;
  newStatus: string;
}

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

export interface DispatchImplementorCommand {
  command: 'dispatchImplementor';
  issueNumber: number;
}

export interface DispatchReviewerCommand {
  command: 'dispatchReviewer';
  issueNumber: number;
}

export interface CancelAgentCommand {
  command: 'cancelAgent';
  issueNumber: number;
}

export interface CancelPlannerCommand {
  command: 'cancelPlanner';
}

export interface ShutdownCommand {
  command: 'shutdown';
}

export type EngineCommand =
  | DispatchImplementorCommand
  | DispatchReviewerCommand
  | CancelAgentCommand
  | CancelPlannerCommand
  | ShutdownCommand;

// ---------------------------------------------------------------------------
// Query Results
// ---------------------------------------------------------------------------

export interface IssueDetailsResult {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string; // ISO 8601
}

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

export interface SpecChange {
  filePath: string;
  frontmatterStatus: string;
  changeType: 'added' | 'modified';
}

export interface SpecPollerBatchResult {
  changes: SpecChange[];
  commitSHA: string; // HEAD commit on default branch (for diff URLs)
}

// ---------------------------------------------------------------------------
// SpecPoller Snapshot
// ---------------------------------------------------------------------------

export type { SpecPollerFileEntry, SpecPollerSnapshot } from './engine/pollers/types.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface IssuePollerConfig {
  pollInterval?: number; // seconds, default: 30
}

export interface SpecPollerConfig {
  pollInterval?: number; // seconds, default: 60
  specsDir?: string; // default: 'docs/specs/'
  defaultBranch?: string; // default: 'main'
}

export interface AgentsConfig {
  agentPlanner?: string; // agent name, default: 'planner'
  agentImplementor?: string; // agent name, default: 'implementor'
  agentReviewer?: string; // agent name, default: 'reviewer'
  maxAgentDuration?: number; // seconds, default: 1800
}

export interface LoggingConfig {
  agentSessions?: boolean; // default: false
  logsDir?: string; // default: 'logs'
}

export interface EngineConfig {
  repository: string; // owner/repo format
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel?: 'debug' | 'info' | 'error'; // default: 'info'
  shutdownTimeout?: number; // seconds, default: 300
  issuePoller?: IssuePollerConfig;
  specPoller?: SpecPollerConfig;
  agents?: AgentsConfig;
  logging?: LoggingConfig;
}

// ---------------------------------------------------------------------------
// Engine Interface
// ---------------------------------------------------------------------------

export interface StartupResult {
  issueCount: number;
  recoveriesPerformed: number;
}

// Startup contract: Callers MUST subscribe to the event emitter (via on())
// before calling start(). Events emitted during startup recovery are
// delivered synchronously within the start() call. If the caller subscribes
// after start() resolves, startup recovery events are lost.
export interface Engine {
  start: () => Promise<StartupResult>; // resolves after startup recovery + first IssuePoller and SpecPoller cycles complete
  on: (handler: (event: EngineEvent) => void | Promise<void>) => () => void; // returns unsubscribe function
  send: (command: EngineCommand) => void;
  getIssueDetails: (issueNumber: number) => Promise<IssueDetailsResult>;
  getPRForIssue: (issueNumber: number) => Promise<PRDetailsResult>;
  getAgentStream: (issueNumber: number) => AgentStream;
}
