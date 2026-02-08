import { match } from 'ts-pattern';
import { createStore } from 'zustand/vanilla';
import type { EngineEvent } from '../types';
import type {
  CreateEngineStoreConfig,
  EngineStore,
  EngineStoreState,
  FocusedPane,
  LastFailure,
  Notification,
  TaskAgentType,
  TrackedIssue,
} from './types';

const STREAM_BUFFER_LIMIT = 10_000;

const PANE_ORDER: FocusedPane[] = ['issueList', 'detailPane', 'notifications'];

export function createEngineStore(config: CreateEngineStoreConfig) {
  const { engine, repository } = config;

  let notificationCounter = 0;

  const store = createStore<EngineStore>((set, get) => ({
    issues: new Map(),
    notifications: [],
    agentStreams: new Map(),
    plannerRunning: false,
    issueDetails: new Map(),
    prDetails: new Map(),
    focusedPane: 'issueList',
    selectedIssue: null,
    shuttingDown: false,

    dispatchImplementor(issueNumber) {
      engine.send({ command: 'dispatchImplementor', issueNumber });
      const issues = new Map(get().issues);
      const issue = issues.get(issueNumber);
      if (issue) {
        issues.set(issueNumber, clearLastFailure(issue));
        set({ issues });
      }
    },

    dispatchReviewer(issueNumber) {
      engine.send({ command: 'dispatchReviewer', issueNumber });
      const issues = new Map(get().issues);
      const issue = issues.get(issueNumber);
      if (issue) {
        issues.set(issueNumber, clearLastFailure(issue));
        set({ issues });
      }
    },

    cancelAgent(issueNumber) {
      engine.send({ command: 'cancelAgent', issueNumber });
    },

    shutdown() {
      engine.send({ command: 'shutdown' });
      set({ shuttingDown: true });
    },

    cycleFocus(direction) {
      const current = get().focusedPane;
      const currentIndex = PANE_ORDER.indexOf(current);
      const offset = direction === 'forward' ? 1 : -1;
      const nextIndex = (currentIndex + offset + PANE_ORDER.length) % PANE_ORDER.length;
      const nextPane = PANE_ORDER[nextIndex];
      if (nextPane) {
        set({ focusedPane: nextPane });
      }
    },

    selectIssue(issueNumber) {
      set({ selectedIssue: issueNumber });
      fetchIssueDetailsIfNeeded(issueNumber);
      fetchPRDetailsIfNeeded(issueNumber);
    },
  }));

  engine.on((event) => {
    handleEngineEvent(event);
  });

  function handleEngineEvent(event: EngineEvent) {
    match(event)
      .with({ type: 'issueStatusChanged' }, (e) => {
        const state = store.getState();
        const issues = new Map(state.issues);
        const existing = issues.get(e.issueNumber);

        const shouldClearFailure = !e.isRecovery && existing?.lastFailure !== undefined;

        const updated = buildTrackedIssue(
          e.issueNumber,
          e.title,
          e.newStatus,
          e.priorityLabel,
          e.createdAt,
          existing?.agentRunning ?? false,
          existing?.agentType,
          shouldClearFailure ? undefined : existing?.lastFailure,
        );

        issues.set(e.issueNumber, updated);

        const issueDetails = markCacheStale(state.issueDetails, e.issueNumber);
        const prDetails = markCacheStale(state.prDetails, e.issueNumber);

        const oldStatusText = e.oldStatus ?? 'none';
        const notification = buildNotification(
          'issueStatusChanged',
          `Issue #${e.issueNumber} status changed from ${oldStatusText} to ${e.newStatus}`,
          e.issueNumber,
        );

        store.setState({
          issues,
          issueDetails,
          prDetails,
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'agentStarted' }, (e) => {
        const state = store.getState();

        if (e.agentType === 'planner') {
          const specPathsText = e.specPaths?.join(', ') ?? '';
          const notification = buildNotification(
            'agentStarted',
            `Planner started for ${specPathsText}`,
          );
          store.setState({
            plannerRunning: true,
            notifications: [...state.notifications, notification],
          });
          return;
        }

        if (e.issueNumber === undefined) return;
        const issueNumber = e.issueNumber;
        const issues = new Map(state.issues);
        const existing = issues.get(issueNumber);
        if (existing) {
          issues.set(issueNumber, {
            ...existing,
            agentRunning: true,
            agentType: e.agentType,
          });
        }

        const agentStreams = new Map(state.agentStreams);
        agentStreams.set(issueNumber, []);

        const agentTypeLabel = e.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
        const notification = buildNotification(
          'agentStarted',
          `${agentTypeLabel} started for issue #${issueNumber}`,
          issueNumber,
        );

        store.setState({
          issues,
          agentStreams,
          notifications: [...state.notifications, notification],
        });

        subscribeToAgentStream(issueNumber);
      })
      .with({ type: 'agentCompleted' }, (e) => {
        const state = store.getState();

        if (e.agentType === 'planner') {
          const notification = buildNotification('agentCompleted', 'Planner completed');
          store.setState({
            plannerRunning: false,
            notifications: [...state.notifications, notification],
          });
          return;
        }

        if (e.issueNumber === undefined) return;
        const issueNumber = e.issueNumber;
        const issues = new Map(state.issues);
        const existing = issues.get(issueNumber);
        if (existing) {
          issues.set(issueNumber, {
            ...existing,
            agentRunning: false,
          });
        }

        const agentTypeLabel = e.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
        const notification = buildNotification(
          'agentCompleted',
          `${agentTypeLabel} completed for issue #${issueNumber}`,
          issueNumber,
        );

        const updates: Partial<EngineStoreState> = {
          issues,
          notifications: [...state.notifications, notification],
        };

        if (e.agentType === 'reviewer') {
          updates.prDetails = markCacheStale(state.prDetails, issueNumber);
        }

        store.setState(updates);

        if (e.agentType === 'implementor') {
          updateNotificationWithPRURL(notification.id, issueNumber);
        }
      })
      .with({ type: 'agentFailed' }, (e) => {
        const state = store.getState();

        if (e.agentType === 'planner') {
          const notification = buildNotification('agentFailed', `Planner failed — ${e.error}`);
          store.setState({
            plannerRunning: false,
            notifications: [...state.notifications, notification],
          });
          return;
        }

        if (e.issueNumber === undefined) return;
        const issueNumber = e.issueNumber;
        const issues = new Map(state.issues);
        const existing = issues.get(issueNumber);
        if (existing) {
          const failure = buildLastFailure(
            e.agentType,
            e.error,
            e.sessionID,
            e.agentType === 'implementor' ? e.worktreePath : undefined,
          );
          issues.set(issueNumber, {
            ...existing,
            agentRunning: false,
            lastFailure: failure,
          });
        }

        const agentTypeLabel = e.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
        const notification = buildNotification(
          'agentFailed',
          `${agentTypeLabel} failed for issue #${issueNumber} — ${e.error}`,
          issueNumber,
        );

        store.setState({
          issues,
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'agentSkipped' }, (e) => {
        const state = store.getState();

        let summary: string;
        if (e.agentType === 'planner') {
          summary = 'Planner skipped — already running (paths deferred)';
        } else {
          const agentTypeLabel = e.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
          summary = `${agentTypeLabel} skipped for issue #${e.issueNumber} — already running`;
        }

        const notification = buildNotification('agentSkipped', summary, e.issueNumber);
        store.setState({
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'dispatchReady' }, (e) => {
        const state = store.getState();
        const notification = buildNotification(
          'dispatchReady',
          `Issue #${e.issueNumber} ready for dispatch`,
          e.issueNumber,
        );
        store.setState({
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'notification' }, (e) => {
        const state = store.getState();

        let summary: string;
        if (e.statusLabel === 'needs-refinement') {
          summary = `Issue #${e.issueNumber} needs spec refinement — ${e.resolutionGuidance}`;
        } else if (e.statusLabel === 'blocked') {
          summary = `Issue #${e.issueNumber} blocked — ${e.resolutionGuidance}`;
        } else {
          summary = `Issue #${e.issueNumber} approved — ready to merge`;
        }

        const notification = buildNotification(
          'notification',
          summary,
          e.issueNumber,
          e.contextURL,
          e.clipboardCommand,
        );

        store.setState({
          notifications: [...state.notifications, notification],
        });

        if (e.statusLabel === 'approved') {
          updateNotificationWithPRURL(notification.id, e.issueNumber);
        }
      })
      .with({ type: 'notificationDismissed' }, (e) => {
        const state = store.getState();
        const notification = buildNotification(
          'notificationDismissed',
          `Issue #${e.issueNumber} notification dismissed`,
          e.issueNumber,
        );
        store.setState({
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'issueRemoved' }, (e) => {
        const state = store.getState();
        const issues = new Map(state.issues);
        issues.delete(e.issueNumber);

        const agentStreams = new Map(state.agentStreams);
        agentStreams.delete(e.issueNumber);

        const issueDetails = new Map(state.issueDetails);
        issueDetails.delete(e.issueNumber);

        const prDetails = new Map(state.prDetails);
        prDetails.delete(e.issueNumber);

        const selectedIssue = state.selectedIssue === e.issueNumber ? null : state.selectedIssue;

        const notification = buildNotification(
          'issueRemoved',
          `Issue #${e.issueNumber} removed`,
          e.issueNumber,
        );

        store.setState({
          issues,
          agentStreams,
          issueDetails,
          prDetails,
          selectedIssue,
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'recoveryPerformed' }, (e) => {
        const state = store.getState();
        const notification = buildNotification(
          'recoveryPerformed',
          `Issue #${e.issueNumber} recovered from stale in-progress`,
          e.issueNumber,
        );
        store.setState({
          notifications: [...state.notifications, notification],
        });
      })
      .with({ type: 'specChanged' }, (e) => {
        const state = store.getState();
        const notification = buildNotification(
          'specChanged',
          `Spec changed: ${e.filePath}`,
          undefined,
          `https://github.com/${repository}/commit/${e.commitSHA}`,
        );
        store.setState({
          notifications: [...state.notifications, notification],
        });
      })
      .exhaustive();
  }

  function buildNotification(
    eventType: string,
    summary: string,
    issueNumber?: number,
    contextURL?: string,
    clipboardCommand?: string,
  ): Notification {
    notificationCounter++;
    const notification: Notification = {
      id: `notif-${notificationCounter}`,
      timestamp: new Date().toISOString(),
      eventType,
      summary,
    };
    if (issueNumber !== undefined) {
      notification.issueNumber = issueNumber;
    }
    if (contextURL !== undefined) {
      notification.contextURL = contextURL;
    }
    if (clipboardCommand !== undefined) {
      notification.clipboardCommand = clipboardCommand;
    }
    return notification;
  }

  function subscribeToAgentStream(issueNumber: number) {
    const stream = engine.getAgentStream(issueNumber);
    if (!stream) return;

    (async () => {
      for await (const chunk of stream) {
        const state = store.getState();
        const agentStreams = new Map(state.agentStreams);
        const buffer = agentStreams.get(issueNumber) ?? [];
        const updatedBuffer = [...buffer, chunk];

        if (updatedBuffer.length > STREAM_BUFFER_LIMIT) {
          updatedBuffer.splice(0, updatedBuffer.length - STREAM_BUFFER_LIMIT);
        }

        agentStreams.set(issueNumber, updatedBuffer);
        store.setState({ agentStreams });
      }
    })();
  }

  function fetchIssueDetailsIfNeeded(issueNumber: number) {
    const state = store.getState();
    const cached = state.issueDetails.get(issueNumber);

    if (cached && !cached.stale) return;

    if (!cached) {
      engine.getIssueDetails(issueNumber).then((result) => {
        const current = store.getState();
        const issueDetails = new Map(current.issueDetails);
        issueDetails.set(issueNumber, {
          body: result.body,
          labels: result.labels,
          stale: false,
        });
        store.setState({ issueDetails });
      });
      return;
    }

    engine
      .getIssueDetails(issueNumber)
      .then((result) => {
        const current = store.getState();
        const issueDetails = new Map(current.issueDetails);
        issueDetails.set(issueNumber, {
          body: result.body,
          labels: result.labels,
          stale: false,
        });
        store.setState({ issueDetails });
      })
      .catch(() => {
        // Retain stale data on fetch failure; cache remains stale for next retry
      });
  }

  function fetchPRDetailsIfNeeded(issueNumber: number) {
    const state = store.getState();
    const cached = state.prDetails.get(issueNumber);

    if (cached && !cached.stale) return;

    if (!cached) {
      engine.getPRForIssue(issueNumber).then((result) => {
        if (!result) return;
        const current = store.getState();
        const prDetails = new Map(current.prDetails);
        prDetails.set(issueNumber, { ...result, stale: false });
        store.setState({ prDetails });
      });
      return;
    }

    engine
      .getPRForIssue(issueNumber)
      .then((result) => {
        if (!result) return;
        const current = store.getState();
        const prDetails = new Map(current.prDetails);
        prDetails.set(issueNumber, { ...result, stale: false });
        store.setState({ prDetails });
      })
      .catch(() => {
        // Retain stale data on fetch failure; cache remains stale for next retry
      });
  }

  function updateNotificationWithPRURL(notificationID: string, issueNumber: number) {
    engine.getPRForIssue(issueNumber).then((result) => {
      if (!result) return;
      const state = store.getState();
      const index = state.notifications.findIndex((n) => n.id === notificationID);
      if (index === -1) return;

      const existing = state.notifications[index];
      if (!existing) return;

      const notifications = [...state.notifications];
      notifications[index] = { ...existing, contextURL: result.url };
      store.setState({ notifications });
    });
  }

  return store;
}

function buildTrackedIssue(
  number: number,
  title: string,
  statusLabel: string,
  priorityLabel: string,
  createdAt: string,
  agentRunning: boolean,
  agentType: TaskAgentType | undefined,
  lastFailure: LastFailure | undefined,
): TrackedIssue {
  const issue: TrackedIssue = {
    number,
    title,
    statusLabel,
    priorityLabel,
    createdAt,
    agentRunning,
  };
  if (agentType !== undefined) {
    issue.agentType = agentType;
  }
  if (lastFailure !== undefined) {
    issue.lastFailure = lastFailure;
  }
  return issue;
}

function buildLastFailure(
  agentType: TaskAgentType,
  error: string,
  sessionID: string,
  worktreePath: string | undefined,
): LastFailure {
  const failure: LastFailure = { agentType, error, sessionID };
  if (worktreePath !== undefined) {
    failure.worktreePath = worktreePath;
  }
  return failure;
}

function clearLastFailure(issue: TrackedIssue): TrackedIssue {
  const { lastFailure: _, ...rest } = issue;
  return rest;
}

function markCacheStale<T extends { stale: boolean }>(
  cache: Map<number, T>,
  issueNumber: number,
): Map<number, T> {
  const entry = cache.get(issueNumber);
  if (!entry) return cache;
  const updated = new Map(cache);
  updated.set(issueNumber, { ...entry, stale: true });
  return updated;
}

export function selectRunningAgentCount(state: EngineStoreState): number {
  let count = 0;
  for (const issue of state.issues.values()) {
    if (issue.agentRunning) count++;
  }
  if (state.plannerRunning) count++;
  return count;
}
