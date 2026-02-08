import type { SpecPollerBatchResult } from '../../types';

// ---------------------------------------------------------------------------
// IssuePoller
// ---------------------------------------------------------------------------

export type IssueSnapshot = {
  issueNumber: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string;
};

export type IssuePoller = {
  poll(): Promise<void>;
  getSnapshot(): ReadonlyMap<number, IssueSnapshot>;
};

// ---------------------------------------------------------------------------
// SpecPoller
// ---------------------------------------------------------------------------

export type LogError = (message: string, error: unknown) => void;

export type SpecPoller = {
  poll(): Promise<SpecPollerBatchResult>;
};
