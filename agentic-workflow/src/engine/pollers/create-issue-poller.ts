import type { EngineEvent, IssueStatusChangedEvent } from '../../types.ts';
import type { EventEmitter } from '../event-emitter/types.ts';
import type { GitHubClient } from '../github-client/types.ts';
import type { IssuePoller, IssueSnapshot } from './types.ts';

interface IssuePollerConfig {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  emitter: EventEmitter;
  logError?: (message: string, error: unknown) => void;
}

export function createIssuePoller(config: IssuePollerConfig): IssuePoller {
  const { octokit, owner, repo, emitter } = config;
  const logError = config.logError ?? defaultLogError;
  const snapshot = new Map<number, IssueSnapshot>();

  async function poll(): Promise<void> {
    try {
      const response = await octokit.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        labels: 'task:implement',
        per_page: 100,
      });

      const currentIssueNumbers = new Set<number>();
      const events: EngineEvent[] = [];

      for (const issue of response.data) {
        currentIssueNumbers.add(issue.number);

        const statusLabel = extractLabelValue(issue.labels, 'status:');
        const priorityLabel = extractLabel(issue.labels, 'priority:');
        const complexityLabel = extractLabel(issue.labels, 'complexity:');

        const existing = snapshot.get(issue.number);

        if (!existing) {
          // New issue -- emit with oldStatus: null
          events.push(
            buildStatusChangedEvent({
              issueNumber: issue.number,
              title: issue.title,
              oldStatus: null,
              newStatus: statusLabel,
              priorityLabel,
              createdAt: issue.created_at,
            }),
          );
        } else if (existing.statusLabel !== statusLabel) {
          // Existing issue -- status label changed
          events.push(
            buildStatusChangedEvent({
              issueNumber: issue.number,
              title: issue.title,
              oldStatus: existing.statusLabel,
              newStatus: statusLabel,
              priorityLabel,
              createdAt: issue.created_at,
            }),
          );
        }

        // Update snapshot with latest data (title, priority, complexity may change)
        snapshot.set(issue.number, {
          issueNumber: issue.number,
          title: issue.title,
          statusLabel,
          priorityLabel,
          complexityLabel,
          createdAt: issue.created_at,
        });
      }

      // Detect removed issues (present in snapshot but absent from current results)
      const removedEvents: IssueStatusChangedEvent[] = [];
      for (const issueNumber of snapshot.keys()) {
        if (!currentIssueNumbers.has(issueNumber)) {
          const existing = snapshot.get(issueNumber);
          removedEvents.push({
            type: 'issueStatusChanged',
            issueNumber,
            title: existing?.title ?? '',
            oldStatus: existing?.statusLabel ?? null,
            newStatus: null,
            priorityLabel: existing?.priorityLabel ?? '',
            createdAt: existing?.createdAt ?? '',
          });
        }
      }

      // Remove from snapshot
      for (const event of removedEvents) {
        snapshot.delete(event.issueNumber);
      }

      // Emit all events: status changes first, then removals
      for (const event of events) {
        emitter.emit(event);
      }
      for (const event of removedEvents) {
        emitter.emit(event);
      }
    } catch (error) {
      logError('IssuePoller poll cycle failed', error);
    }
  }

  function getSnapshot(): ReadonlyMap<number, IssueSnapshot> {
    return snapshot;
  }

  function getSnapshotMap(): Map<number, IssueSnapshot> {
    return snapshot;
  }

  function updateEntry(issueNumber: number, update: Partial<IssueSnapshot>): void {
    const existing = snapshot.get(issueNumber);
    if (!existing) {
      return;
    }
    snapshot.set(issueNumber, { ...existing, ...update });
  }

  return { poll, getSnapshot, getSnapshotMap, updateEntry };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLabelValue(labels: (string | { name?: string })[], prefix: string): string {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label.name;
    if (name?.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return '';
}

function extractLabel(labels: (string | { name?: string })[], prefix: string): string {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label.name;
    if (name?.startsWith(prefix)) {
      return name;
    }
  }
  return '';
}

interface BuildStatusChangedEventParams {
  issueNumber: number;
  title: string;
  oldStatus: string | null;
  newStatus: string;
  priorityLabel: string;
  createdAt: string;
}

function buildStatusChangedEvent(params: BuildStatusChangedEventParams): IssueStatusChangedEvent {
  return {
    type: 'issueStatusChanged',
    issueNumber: params.issueNumber,
    title: params.title,
    oldStatus: params.oldStatus,
    newStatus: params.newStatus,
    priorityLabel: params.priorityLabel,
    createdAt: params.createdAt,
  };
}

function defaultLogError(message: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: fallback logger when none is injected
  console.error(message, error);
}
