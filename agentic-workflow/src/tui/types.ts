import type { Engine } from '../types.ts';

// ---------------------------------------------------------------------------
// Task Model
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'ready-to-implement'
  | 'agent-implementing'
  | 'agent-reviewing'
  | 'needs-refinement'
  | 'blocked'
  | 'ready-to-merge'
  | 'agent-crashed';

export type Priority = 'high' | 'medium' | 'low';

export type CIStatus = 'pending' | 'success' | 'failure';

export type AgentType = 'implementor' | 'reviewer';

export interface TaskPR {
  number: number;
  url: string;
  ciStatus: CIStatus | null;
}

export interface AgentCrash {
  error: string;
}

export interface TaskAgent {
  type: AgentType;
  running: boolean;
  sessionID: string;
  branchName?: string;
  logFilePath?: string;
  crash?: AgentCrash;
}

export interface Task {
  issueNumber: number;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  priority: Priority | null;
  agentCount: number;
  createdAt: string;
  prs: TaskPR[];
  agent: TaskAgent | null;
}

// ---------------------------------------------------------------------------
// Section & Sorting
// ---------------------------------------------------------------------------

export type Section = 'action' | 'agents';

export interface SortedTask {
  task: Task;
  section: Section;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

export interface CachedIssueDetail {
  body: string;
  labels: string[];
  stale: boolean;
}

export interface CachedPRDetail {
  title: string;
  changedFilesCount: number;
  failedCheckNames?: string[];
  stale: boolean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface TUIState {
  tasks: Map<number, Task>;
  plannerStatus: 'idle' | 'running';

  selectedIssue: number | null;
  pinnedTask: number | null;
  focusedPane: 'taskList' | 'detailPane';
  shuttingDown: boolean;

  agentStreams: Map<string, string[]>;

  issueDetailCache: Map<number, CachedIssueDetail>;
  prDetailCache: Map<number, CachedPRDetail>;
}

export interface TUIActions {
  dispatch: (issueNumber: number) => void;
  cancelAgent: (issueNumber: number) => void;
  shutdown: () => void;
  selectIssue: (issueNumber: number) => void;
  pinTask: (issueNumber: number) => void;
  cycleFocus: () => void;
}

export type TUIStore = TUIState & TUIActions;

export interface CreateTUIStoreConfig {
  engine: Engine;
}
