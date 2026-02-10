import type { SpecPollerBatchResult } from '../../types.ts';

// ---------------------------------------------------------------------------
// IssuePoller
// ---------------------------------------------------------------------------

export interface IssueSnapshot {
  issueNumber: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string;
}

export interface IssuePoller {
  poll: () => Promise<void>;
  getSnapshot: () => ReadonlyMap<number, IssueSnapshot>;
  getSnapshotMap: () => Map<number, IssueSnapshot>;
}

// ---------------------------------------------------------------------------
// SpecPoller
// ---------------------------------------------------------------------------

export type LogError = (message: string, error: unknown) => void;

export interface SpecPollerFileEntry {
  blobSHA: string;
  frontmatterStatus: string;
}

export interface SpecPollerSnapshot {
  specsDirTreeSHA: string | null;
  files: Record<string, SpecPollerFileEntry>;
}

export interface SpecPoller {
  poll: () => Promise<SpecPollerBatchResult>;
  getSnapshot: () => SpecPollerSnapshot;
}
