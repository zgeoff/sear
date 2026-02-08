import type { EngineEvent, IssueRemovedEvent, IssueStatusChangedEvent } from '../../types';
import type { EventEmitter } from '../event-emitter/types';
import type { GitHubClient } from '../github-client/types';
import type { IssuePoller, IssueSnapshot } from './types';

type IssuePollerConfig = {
  octokit: GitHubClient;
  owner: string;
  repo: string;
  emitter: EventEmitter;
  logError?: (message: string, error: unknown) => void;
};

export function createIssuePoller(config: IssuePollerConfig): IssuePoller {
  const { octokit, owner, repo, emitter, logError = console.error } = config;
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

        const existing = snapshot.get(issue.number);

        if (!existing) {
          // New issue -- emit with oldStatus: null
          events.push(
            buildStatusChangedEvent(
              issue.number,
              issue.title,
              null,
              statusLabel,
              priorityLabel,
              issue.created_at,
            ),
          );
          snapshot.set(issue.number, {
            issueNumber: issue.number,
            title: issue.title,
            statusLabel,
            priorityLabel,
            createdAt: issue.created_at,
          });
          continue;
        }

        // Existing issue -- check for status label change
        if (existing.statusLabel !== statusLabel) {
          events.push(
            buildStatusChangedEvent(
              issue.number,
              issue.title,
              existing.statusLabel,
              statusLabel,
              priorityLabel,
              issue.created_at,
            ),
          );
        }

        // Update snapshot with latest data (title, priority may change)
        snapshot.set(issue.number, {
          issueNumber: issue.number,
          title: issue.title,
          statusLabel,
          priorityLabel,
          createdAt: issue.created_at,
        });
      }

      // Detect removed issues (present in snapshot but absent from current results)
      const removedEvents: IssueRemovedEvent[] = [];
      for (const issueNumber of snapshot.keys()) {
        if (!currentIssueNumbers.has(issueNumber)) {
          removedEvents.push({ type: 'issueRemoved', issueNumber });
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

  return { poll, getSnapshot };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractLabelValue(labels: (string | { name?: string })[], prefix: string): string {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label.name;
    if (name?.startsWith(prefix)) return name.slice(prefix.length);
  }
  return '';
}

function extractLabel(labels: (string | { name?: string })[], prefix: string): string {
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label.name;
    if (name?.startsWith(prefix)) return name;
  }
  return '';
}

function buildStatusChangedEvent(
  issueNumber: number,
  title: string,
  oldStatus: string | null,
  newStatus: string,
  priorityLabel: string,
  createdAt: string,
): IssueStatusChangedEvent {
  return {
    type: 'issueStatusChanged',
    issueNumber,
    title,
    oldStatus,
    newStatus,
    priorityLabel,
    createdAt,
  };
}
