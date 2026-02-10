import type { AgentType } from '../../types.ts';
import type { EventEmitter } from '../event-emitter/types.ts';
import type { GitHubClient } from '../github-client/types.ts';

export interface IssueSnapshotEntry {
  issueNumber: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  complexityLabel: string;
  createdAt: string;
}

export interface IssuePollerSnapshot {
  get: (issueNumber: number) => IssueSnapshotEntry | undefined;
  set: (issueNumber: number, entry: IssueSnapshotEntry) => void;
}

export interface RecoveryConfig {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  emitter: EventEmitter;
}

export interface StartupRecoveryResult {
  recoveriesPerformed: number;
}

export interface CrashRecoveryParams {
  agentType: AgentType;
  issueNumber: number;
  snapshot: IssuePollerSnapshot;
}

export interface Recovery {
  performStartupRecovery: () => Promise<StartupRecoveryResult>;
  performCrashRecovery: (params: CrashRecoveryParams) => Promise<void>;
}
