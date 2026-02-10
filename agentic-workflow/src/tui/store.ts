import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { AgentType, EngineEvent, StartupResult } from '../types.ts';
import type {
  AgentCompletedNotification,
  AgentFailedNotification,
  AgentSkippedNotification,
  AgentStartedNotification,
  BaseNotification,
  CreateEngineStoreConfig,
  DispatchReadyNotification,
  EngineEventNotification,
  EngineStore,
  EngineStoreState,
  FocusedPane,
  IssueRemovedNotification,
  IssueStatusChangedNotification,
  LastFailure,
  NotificationDismissedNotification,
  RecoveryPerformedNotification,
  Repository,
  SpecChangedNotification,
  StartupNotification,
  TaskAgentType,
  TrackedIssue,
} from './types.ts';

const STREAM_BUFFER_LIMIT = 10_000;

const PANE_ORDER: FocusedPane[] = ['issueList', 'detailPane', 'notifications'];

export function createEngineStore(config: CreateEngineStoreConfig): StoreApi<EngineStore> {
  const { engine } = config;
  const repository = parseRepository(config.repository);

  let notificationCounter = 0;

  const store = createStore<EngineStore>((set, get) => ({
    repository,
    issues: new Map(),
    notifications: [],
    agentStreams: new Map(),
    streamViewportOffsets: new Map(),
    plannerRunning: false,
    issueDetails: new Map(),
    prDetails: new Map(),
    focusedPane: 'issueList',
    selectedIssue: null,
    shuttingDown: false,

    dispatchImplementor(issueNumber: number): void {
      engine.send({ command: 'dispatchImplementor', issueNumber });
      const issues = new Map(get().issues);
      const issue = issues.get(issueNumber);
      if (issue) {
        issues.set(issueNumber, clearLastFailure(issue));
        set({ issues });
      }
    },

    dispatchReviewer(issueNumber: number): void {
      engine.send({ command: 'dispatchReviewer', issueNumber });
      const issues = new Map(get().issues);
      const issue = issues.get(issueNumber);
      if (issue) {
        issues.set(issueNumber, clearLastFailure(issue));
        set({ issues });
      }
    },

    cancelAgent(issueNumber: number): void {
      engine.send({ command: 'cancelAgent', issueNumber });
    },

    shutdown(): void {
      set({ shuttingDown: true });
      engine.send({ command: 'shutdown' });
    },

    cycleFocus(direction: 'forward' | 'backward'): void {
      const current = get().focusedPane;
      const currentIndex = PANE_ORDER.indexOf(current);
      const offset = direction === 'forward' ? 1 : -1;
      const nextIndex = (currentIndex + offset + PANE_ORDER.length) % PANE_ORDER.length;
      const nextPane = PANE_ORDER[nextIndex];
      if (nextPane) {
        set({ focusedPane: nextPane });
      }
    },

    selectIssue(issueNumber: number): void {
      set({ selectedIssue: issueNumber });
      fetchIssueDetailsIfNeeded(issueNumber);
      fetchPrDetailsIfNeeded(issueNumber);
    },

    handleStartup(result: StartupResult): void {
      const state = get();
      const notification: StartupNotification = {
        ...buildBaseNotification(),
        eventType: 'startup',
        issueCount: result.issueCount,
        recoveriesPerformed: result.recoveriesPerformed,
        summary: buildStartupSummary(result),
      };
      set({ notifications: [notification, ...state.notifications] });
    },
  }));

  engine.on((event) => {
    handleEngineEvent(event);
  });

  function handleEngineEvent(event: EngineEvent): void {
    match(event)
      .with({ type: 'issueStatusChanged' }, (e) => {
        const state = store.getState();
        const issues = new Map(state.issues);
        const existing = issues.get(e.issueNumber);

        const shouldClearOverlays = !e.isRecovery;

        const updated = buildTrackedIssue({
          number: e.issueNumber,
          title: e.title,
          statusLabel: e.newStatus,
          priorityLabel: e.priorityLabel,
          createdAt: e.createdAt,
          agentRunning: existing?.agentRunning ?? false,
          agentType: existing?.agentType,
          lastFailure:
            shouldClearOverlays && existing?.lastFailure !== undefined
              ? undefined
              : existing?.lastFailure,
          resolutionGuidance:
            shouldClearOverlays && existing?.resolutionGuidance !== undefined
              ? undefined
              : existing?.resolutionGuidance,
        });

        issues.set(e.issueNumber, updated);

        const issueDetails = markCacheStale(state.issueDetails, e.issueNumber);
        const prDetails = markCacheStale(state.prDetails, e.issueNumber);

        const oldStatusText = e.oldStatus ?? 'none';
        const notification: IssueStatusChangedNotification = {
          ...buildBaseNotification(),
          eventType: 'issueStatusChanged',
          issueNumber: e.issueNumber,
          oldStatus: e.oldStatus,
          newStatus: e.newStatus,
          summary: `#${e.issueNumber}: ${oldStatusText} → ${e.newStatus}`,
          contextURL: buildIssueUrl(repository, e.issueNumber),
        };

        store.setState({
          issues,
          issueDetails,
          prDetails,
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'agentStarted' }, (e) => {
        const state = store.getState();

        if (e.agentType === 'planner') {
          const specCount = e.specPaths?.length ?? 0;
          const notification: AgentStartedNotification = {
            ...buildBaseNotification(),
            eventType: 'agentStarted',
            agentType: 'planner',
            specCount,
            summary: `Planner started for ${specCount} specs`,
          };
          store.setState({
            plannerRunning: true,
            notifications: [notification, ...state.notifications],
          });
          return;
        }

        if (e.issueNumber === undefined) {
          return;
        }
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

        const streamViewportOffsets = new Map(state.streamViewportOffsets);
        streamViewportOffsets.delete(issueNumber);

        const agentTypeLabel = formatAgentType(e.agentType);
        const notification: AgentStartedNotification = {
          ...buildBaseNotification(),
          eventType: 'agentStarted',
          agentType: e.agentType,
          issueNumber,
          summary: `${agentTypeLabel} started for #${issueNumber}`,
          contextURL: buildIssueUrl(repository, issueNumber),
        };

        store.setState({
          issues,
          agentStreams,
          streamViewportOffsets,
          notifications: [notification, ...state.notifications],
        });

        subscribeToAgentStream(issueNumber);
      })
      .with({ type: 'agentCompleted' }, (e) => {
        const state = store.getState();

        if (e.agentType === 'planner') {
          const specCount = e.specPaths?.length ?? 0;
          const notification: AgentCompletedNotification = {
            ...buildBaseNotification(),
            eventType: 'agentCompleted',
            agentType: 'planner',
            specCount,
            summary: `Planner completed for ${specCount} specs`,
          };
          if (e.logFilePath !== undefined) {
            notification.logFilePath = e.logFilePath;
          }
          store.setState({
            plannerRunning: false,
            notifications: [notification, ...state.notifications],
          });
          return;
        }

        if (e.issueNumber === undefined) {
          return;
        }
        const issueNumber = e.issueNumber;
        const issues = new Map(state.issues);
        const existing = issues.get(issueNumber);
        if (existing) {
          issues.set(issueNumber, {
            ...existing,
            agentRunning: false,
          });
        }

        const agentTypeLabel = formatAgentType(e.agentType);
        const notification: AgentCompletedNotification = {
          ...buildBaseNotification(),
          eventType: 'agentCompleted',
          agentType: e.agentType,
          issueNumber,
          summary: `${agentTypeLabel} completed for #${issueNumber}`,
          contextURL: buildIssueUrl(repository, issueNumber),
        };
        if (e.logFilePath !== undefined) {
          notification.logFilePath = e.logFilePath;
        }

        const updates: Partial<EngineStoreState> = {
          issues,
          notifications: [notification, ...state.notifications],
        };

        if (e.agentType === 'reviewer') {
          updates.prDetails = markCacheStale(state.prDetails, issueNumber);
        }

        store.setState(updates);

        if (e.agentType === 'implementor') {
          updateNotificationWithPrurl(notification.id, issueNumber);
        }
      })
      .with({ type: 'agentFailed' }, (e) => {
        const state = store.getState();

        if (e.agentType === 'planner') {
          const notification: AgentFailedNotification = {
            ...buildBaseNotification(),
            eventType: 'agentFailed',
            agentType: 'planner',
            error: e.error,
            sessionID: e.sessionID,
            summary: `Planner failed — ${e.error}`,
          };
          if (e.logFilePath !== undefined) {
            notification.logFilePath = e.logFilePath;
          }
          store.setState({
            plannerRunning: false,
            notifications: [notification, ...state.notifications],
          });
          return;
        }

        if (e.issueNumber === undefined) {
          return;
        }
        const issueNumber = e.issueNumber;
        const issues = new Map(state.issues);
        const existing = issues.get(issueNumber);
        if (existing) {
          const failure = buildLastFailure({
            agentType: e.agentType,
            error: e.error,
            sessionId: e.sessionID,
            worktreePath: e.agentType === 'implementor' ? e.worktreePath : undefined,
            logFilePath: e.logFilePath,
          });
          issues.set(issueNumber, {
            ...existing,
            agentRunning: false,
            lastFailure: failure,
          });
        }

        const agentTypeLabel = formatAgentType(e.agentType);
        const notification: AgentFailedNotification = {
          ...buildBaseNotification(),
          eventType: 'agentFailed',
          agentType: e.agentType,
          issueNumber,
          error: e.error,
          sessionID: e.sessionID,
          summary: `${agentTypeLabel} failed for #${issueNumber} — ${e.error}`,
          contextURL: buildIssueUrl(repository, issueNumber),
        };
        if (e.logFilePath !== undefined) {
          notification.logFilePath = e.logFilePath;
        }

        store.setState({
          issues,
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'agentSkipped' }, (e) => {
        const state = store.getState();

        let summary: string;
        if (e.agentType === 'planner') {
          summary = 'Planner skipped — paths deferred';
        } else {
          const agentTypeLabel = formatAgentType(e.agentType);
          summary = `${agentTypeLabel} skipped for #${e.issueNumber}`;
        }

        const notification: AgentSkippedNotification = {
          ...buildBaseNotification(),
          eventType: 'agentSkipped',
          agentType: e.agentType,
          summary,
        };
        if (e.issueNumber !== undefined) {
          notification.issueNumber = e.issueNumber;
          notification.contextURL = buildIssueUrl(repository, e.issueNumber);
        }
        store.setState({
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'dispatchReady' }, (e) => {
        const state = store.getState();
        const notification: DispatchReadyNotification = {
          ...buildBaseNotification(),
          eventType: 'dispatchReady',
          issueNumber: e.issueNumber,
          summary: `#${e.issueNumber} ready for dispatch`,
          contextURL: buildIssueUrl(repository, e.issueNumber),
        };
        store.setState({
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'notification' }, (e) => {
        const state = store.getState();

        const { notificationType, summary } = match(e.statusLabel)
          .with('needs-refinement', (s) => ({
            notificationType: s,
            summary: `#${e.issueNumber} needs refinement — ${e.resolutionGuidance}`,
          }))
          .with('blocked', (s) => ({
            notificationType: s,
            summary: `#${e.issueNumber} blocked — ${e.resolutionGuidance}`,
          }))
          .otherwise(() => ({
            notificationType: 'approved' as const,
            summary: `#${e.issueNumber} approved — ready to merge`,
          }));

        const notification: EngineEventNotification = {
          ...buildBaseNotification(),
          eventType: 'notification',
          issueNumber: e.issueNumber,
          notificationType,
          summary,
          contextURL: e.contextURL,
        };
        if (e.resolutionGuidance !== undefined) {
          notification.resolutionGuidance = e.resolutionGuidance;
        }
        if (e.clipboardCommand !== undefined) {
          notification.clipboardCommand = e.clipboardCommand;
        }

        const issues = new Map(state.issues);
        const existing = issues.get(e.issueNumber);
        if (existing && e.resolutionGuidance !== undefined) {
          issues.set(e.issueNumber, { ...existing, resolutionGuidance: e.resolutionGuidance });
        }

        const updates: Partial<EngineStoreState> = {
          notifications: [notification, ...state.notifications],
        };
        if (existing && e.resolutionGuidance !== undefined) {
          updates.issues = issues;
        }

        store.setState(updates);

        if (e.statusLabel === 'approved') {
          updateNotificationWithPrurl(notification.id, e.issueNumber);
        }
      })
      .with({ type: 'notificationDismissed' }, (e) => {
        const state = store.getState();
        const notification: NotificationDismissedNotification = {
          ...buildBaseNotification(),
          eventType: 'notificationDismissed',
          issueNumber: e.issueNumber,
          summary: `#${e.issueNumber} dismissed`,
          contextURL: buildIssueUrl(repository, e.issueNumber),
        };
        store.setState({
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'issueRemoved' }, (e) => {
        const state = store.getState();
        const issues = new Map(state.issues);
        issues.delete(e.issueNumber);

        const agentStreams = new Map(state.agentStreams);
        agentStreams.delete(e.issueNumber);

        const streamViewportOffsets = new Map(state.streamViewportOffsets);
        streamViewportOffsets.delete(e.issueNumber);

        const issueDetails = new Map(state.issueDetails);
        issueDetails.delete(e.issueNumber);

        const prDetails = new Map(state.prDetails);
        prDetails.delete(e.issueNumber);

        const selectedIssue = state.selectedIssue === e.issueNumber ? null : state.selectedIssue;

        const notification: IssueRemovedNotification = {
          ...buildBaseNotification(),
          eventType: 'issueRemoved',
          issueNumber: e.issueNumber,
          summary: `#${e.issueNumber} removed`,
          contextURL: buildIssueUrl(repository, e.issueNumber),
        };

        store.setState({
          issues,
          agentStreams,
          streamViewportOffsets,
          issueDetails,
          prDetails,
          selectedIssue,
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'recoveryPerformed' }, (e) => {
        const state = store.getState();
        const notification: RecoveryPerformedNotification = {
          ...buildBaseNotification(),
          eventType: 'recoveryPerformed',
          issueNumber: e.issueNumber,
          summary: `#${e.issueNumber} recovered from stale`,
          contextURL: buildIssueUrl(repository, e.issueNumber),
        };
        store.setState({
          notifications: [notification, ...state.notifications],
        });
      })
      .with({ type: 'specChanged' }, (e) => {
        const state = store.getState();
        const specFileName = extractFileName(e.filePath);
        const notification: SpecChangedNotification = {
          ...buildBaseNotification(),
          eventType: 'specChanged',
          specFileName,
          summary: `Spec changed: ${specFileName}`,
          contextURL: `https://github.com/${config.repository}/commit/${e.commitSHA}`,
        };
        store.setState({
          notifications: [notification, ...state.notifications],
        });
      })
      .exhaustive();
  }

  function buildBaseNotification(): BaseNotification {
    notificationCounter += 1;
    return {
      id: `notif-${notificationCounter}`,
      timestamp: new Date().toISOString(),
      summary: '',
    };
  }

  function subscribeToAgentStream(issueNumber: number): void {
    const stream = engine.getAgentStream(issueNumber);
    if (!stream) {
      return;
    }

    void (async () => {
      for await (const chunk of stream) {
        const lines = splitChunkIntoLines(chunk);
        if (lines.length > 0) {
          appendStreamLines(issueNumber, lines);
        }
      }
    })();
  }

  function appendStreamLines(issueNumber: number, lines: string[]): void {
    const state = store.getState();
    const agentStreams = new Map(state.agentStreams);
    const buffer = [...(agentStreams.get(issueNumber) ?? []), ...lines];

    const overflow = buffer.length - STREAM_BUFFER_LIMIT;
    const updates: Partial<EngineStoreState> = {};

    if (overflow > 0) {
      buffer.splice(0, overflow);
      const currentOffset = state.streamViewportOffsets.get(issueNumber) ?? 0;
      if (currentOffset > 0) {
        const streamViewportOffsets = new Map(state.streamViewportOffsets);
        const newOffset = Math.max(0, currentOffset - overflow);
        streamViewportOffsets.set(issueNumber, newOffset);
        updates.streamViewportOffsets = streamViewportOffsets;
      }
    }

    agentStreams.set(issueNumber, buffer);
    updates.agentStreams = agentStreams;
    store.setState(updates);
  }

  function fetchIssueDetailsIfNeeded(issueNumber: number): void {
    const state = store.getState();
    const cached = state.issueDetails.get(issueNumber);

    if (cached && !cached.stale) {
      return;
    }

    if (!cached) {
      void engine.getIssueDetails(issueNumber).then((result) => {
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

    void engine
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

  function fetchPrDetailsIfNeeded(issueNumber: number): void {
    const state = store.getState();
    const cached = state.prDetails.get(issueNumber);

    if (cached && !cached.stale) {
      return;
    }

    if (!cached) {
      void engine.getPRForIssue(issueNumber).then((result) => {
        if (!result) {
          return;
        }
        const current = store.getState();
        const prDetails = new Map(current.prDetails);
        prDetails.set(issueNumber, { ...result, stale: false });
        store.setState({ prDetails });
      });
      return;
    }

    void engine
      .getPRForIssue(issueNumber)
      .then((result) => {
        if (!result) {
          return;
        }
        const current = store.getState();
        const prDetails = new Map(current.prDetails);
        prDetails.set(issueNumber, { ...result, stale: false });
        store.setState({ prDetails });
      })
      .catch(() => {
        // Retain stale data on fetch failure; cache remains stale for next retry
      });
  }

  function updateNotificationWithPrurl(notificationId: string, issueNumber: number): void {
    void engine.getPRForIssue(issueNumber).then((result) => {
      if (!result) {
        return;
      }
      const state = store.getState();
      const index = state.notifications.findIndex((n) => n.id === notificationId);
      if (index === -1) {
        return;
      }

      const existing = state.notifications[index];
      if (!existing) {
        return;
      }

      const notifications = [...state.notifications];
      notifications[index] = { ...existing, contextURL: result.url };
      store.setState({ notifications });
    });
  }

  return store;
}

interface BuildTrackedIssueParams {
  number: number;
  title: string;
  statusLabel: string;
  priorityLabel: string;
  createdAt: string;
  agentRunning: boolean;
  agentType: TaskAgentType | undefined;
  lastFailure: LastFailure | undefined;
  resolutionGuidance: string | undefined;
}

function buildTrackedIssue(params: BuildTrackedIssueParams): TrackedIssue {
  const issue: TrackedIssue = {
    number: params.number,
    title: params.title,
    statusLabel: params.statusLabel,
    priorityLabel: params.priorityLabel,
    createdAt: params.createdAt,
    agentRunning: params.agentRunning,
  };
  if (params.agentType !== undefined) {
    issue.agentType = params.agentType;
  }
  if (params.lastFailure !== undefined) {
    issue.lastFailure = params.lastFailure;
  }
  if (params.resolutionGuidance !== undefined) {
    issue.resolutionGuidance = params.resolutionGuidance;
  }
  return issue;
}

interface BuildLastFailureParams {
  agentType: TaskAgentType;
  error: string;
  sessionId: string;
  worktreePath: string | undefined;
  logFilePath: string | undefined;
}

function buildLastFailure(params: BuildLastFailureParams): LastFailure {
  const failure: LastFailure = {
    agentType: params.agentType,
    error: params.error,
    sessionID: params.sessionId,
  };
  if (params.worktreePath !== undefined) {
    failure.worktreePath = params.worktreePath;
  }
  if (params.logFilePath !== undefined) {
    failure.logFilePath = params.logFilePath;
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
  if (!entry) {
    return cache;
  }
  const updated = new Map(cache);
  updated.set(issueNumber, { ...entry, stale: true });
  return updated;
}

function parseRepository(repositoryString: string): Repository {
  const parts = repositoryString.split('/');
  return { owner: parts[0] ?? '', repo: parts[1] ?? '' };
}

function buildIssueUrl(repo: Repository, issueNumber: number): string {
  return `https://github.com/${repo.owner}/${repo.repo}/issues/${issueNumber}`;
}

function formatAgentType(agentType: AgentType): string {
  return match(agentType)
    .with('implementor', () => 'Implementor')
    .with('reviewer', () => 'Reviewer')
    .with('planner', () => 'Planner')
    .exhaustive();
}

function extractFileName(filePath: string): string {
  const parts = filePath.split('/');
  return parts.at(-1) ?? filePath;
}

function splitChunkIntoLines(chunk: string): string[] {
  const parts = chunk.split('\n');
  if (parts.length > 0 && parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}

function buildStartupSummary(result: StartupResult): string {
  const parts = [`Startup complete: ${result.issueCount} issues tracked`];
  if (result.recoveriesPerformed > 0) {
    parts.push(`${result.recoveriesPerformed} recoveries performed`);
  }
  return parts.join(', ');
}

export function selectRunningAgentCount(state: EngineStoreState): number {
  let count = 0;
  for (const issue of state.issues.values()) {
    if (issue.agentRunning) {
      count += 1;
    }
  }
  if (state.plannerRunning) {
    count += 1;
  }
  return count;
}
