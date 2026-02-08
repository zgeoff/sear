import type { IssueStatusChangedEvent, SpecPollerBatchResult } from '../../types';

export type AgentManagerDelegate = {
  dispatchPlanner(specPaths: string[]): void;
  dispatchReviewer(issueNumber: number): void;
  isPlannerRunning(): boolean;
};

export type DispatchConfig = {
  repository: string; // owner/repo format
};

export type Dispatch = {
  handleSpecPollerResult(result: SpecPollerBatchResult): void;
  handleIssueStatusChanged(event: IssueStatusChangedEvent): void;
};
