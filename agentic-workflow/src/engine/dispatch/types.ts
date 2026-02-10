import type { IssueStatusChangedEvent, SpecPollerBatchResult } from '../../types.ts';

export interface AgentManagerDelegate {
  dispatchPlanner: (specPaths: string[]) => Promise<void>;
  dispatchReviewer: (issueNumber: number) => void;
  isPlannerRunning: () => boolean;
}

export interface DispatchConfig {
  repository: string; // owner/repo format
}

export interface Dispatch {
  handleSpecPollerResult: (result: SpecPollerBatchResult) => void;
  handleIssueStatusChanged: (event: IssueStatusChangedEvent) => void;
  handlePlannerFailed: (specPaths: string[]) => void;
}
