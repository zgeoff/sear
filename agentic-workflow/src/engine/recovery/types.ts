import type { AgentType } from '../../types.js';
import type { EventEmitter } from '../event-emitter/create-event-emitter.js';
import type { GitHubClient } from '../github-client.js';

export type IssueSnapshotEntry = {
  issueNumber: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string;
};

export type IssuePollerSnapshot = {
  get(issueNumber: number): IssueSnapshotEntry | undefined;
  set(issueNumber: number, entry: IssueSnapshotEntry): void;
};

export type RecoveryConfig = {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  emitter: EventEmitter;
};

export type StartupRecoveryResult = {
  recoveriesPerformed: number;
};

export type CrashRecoveryParams = {
  agentType: AgentType;
  issueNumber: number;
  snapshot: IssuePollerSnapshot;
};

export type Recovery = {
  performStartupRecovery(): Promise<StartupRecoveryResult>;
  performCrashRecovery(params: CrashRecoveryParams): Promise<void>;
};
