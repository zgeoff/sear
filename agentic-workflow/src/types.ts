// ---------------------------------------------------------------------------
// Engine Events
// ---------------------------------------------------------------------------

export interface IssueStatusChangedEvent {
  type: 'issueStatusChanged';
  issueNumber: number;
  title: string;
  oldStatus: string | null; // null on first detection
  newStatus: string | null; // null when the issue is removed (closed or task:implement label removed)
  priorityLabel: string;
  createdAt: string; // ISO 8601
  isRecovery?: boolean; // true when emitted as synthetic event from crash recovery
  isEngineTransition?: boolean; // true when emitted as the synthetic event from completion-dispatch (engine sets status:review on Implementor completion)
  // isRecovery and isEngineTransition are mutually exclusive — at most one is true on any given event.
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
  specPaths?: string[]; // guaranteed present when agentType is 'planner'
  sessionID: string;
  branchName?: string; // present for Implementor and Reviewer
  logFilePath?: string; // present when logging.agentSessions is enabled
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
  branchName?: string; // present for Implementor and Reviewer — the branch persists after worktree cleanup for inspection
  logFilePath?: string; // present when logging.agentSessions is enabled
}

export interface PRLinkedEvent {
  type: 'prLinked';
  issueNumber: number;
  prNumber: number;
  url: string; // PR URL
  ciStatus: 'pending' | 'success' | 'failure' | null; // current CI status at detection time
}

export interface CIStatusChangedEvent {
  type: 'ciStatusChanged';
  prNumber: number;
  issueNumber?: number; // present when the PR is linked to a tracked issue
  oldCIStatus: 'pending' | 'success' | 'failure' | null; // null on first detection
  newCIStatus: 'pending' | 'success' | 'failure';
}

export type EngineEvent =
  | IssueStatusChangedEvent
  | SpecChangedEvent
  | AgentStartedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | PRLinkedEvent
  | CIStatusChangedEvent;

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
  isDraft: boolean;
  headRefName: string; // branch name — used by engine for worktree strategy (resume from PR branch)
} | null;

export interface PRFileEntry {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
}

export interface PRReview {
  id: number;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
}

export interface PRInlineComment {
  id: number;
  author: string;
  body: string;
  path: string;
  line: number | null;
}

export interface PRReviewsResult {
  reviews: PRReview[];
  comments: PRInlineComment[];
}

export interface CICheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'neutral'
    | 'skipped'
    | 'stale'
    | null; // null when status is not 'completed'
  detailsURL: string;
}

export interface CIStatusResult {
  overall: 'pending' | 'success' | 'failure';
  failedCheckRuns: CICheckRun[]; // only check runs with conclusion 'failure', 'cancelled', or 'timed_out'
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

// getAgentStream returns null if no agent session exists for the given sessionID
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

export interface PRPollerConfig {
  pollInterval?: number; // seconds, default: 30
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
  prPoller?: PRPollerConfig;
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
  start: () => Promise<StartupResult>; // resolves after planner cache load, startup recovery, and first IssuePoller, SpecPoller, and PR Poller cycles complete
  on: (handler: (event: EngineEvent) => void | Promise<void>) => () => void; // returns unsubscribe function
  send: (command: EngineCommand) => void;
  getIssueDetails: (issueNumber: number) => Promise<IssueDetailsResult>;
  getPRForIssue: (
    issueNumber: number,
    options?: { includeDrafts?: boolean },
  ) => Promise<PRDetailsResult>;
  getPRFiles: (prNumber: number) => Promise<PRFileEntry[]>;
  getPRReviews: (prNumber: number) => Promise<PRReviewsResult>;
  getCIStatus: (prNumber: number) => Promise<CIStatusResult>;
  getAgentStream: (sessionID: string) => AgentStream;
}
