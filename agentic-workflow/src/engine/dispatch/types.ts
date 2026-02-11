import type { IssueStatusChangedEvent, SpecPollerBatchResult } from '../../types.ts';

export interface AgentManagerDelegate {
  dispatchPlanner: (specPaths: string[]) => Promise<void>;
  isPlannerRunning: () => boolean;
}

export interface DispatchConfig {
  repository: string; // owner/repo format
}

export interface Dispatch {
  handleSpecPollerResult: (result: SpecPollerBatchResult) => Promise<void>;
  handleIssueStatusChanged: (event: IssueStatusChangedEvent) => Promise<void>;
  handlePlannerFailed: (specPaths: string[]) => void;
}
