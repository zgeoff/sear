import memoizee from 'memoizee';
import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { EngineEvent } from '../types.ts';
import type {
  AgentType,
  CreateTUIStoreConfig,
  Priority,
  Section,
  SortedTask,
  Task,
  TaskAgent,
  TaskStatus,
  TUIState,
  TUIStore,
} from './types.ts';

const STREAM_BUFFER_LIMIT = 10_000;

const STATUS_LABEL_MAP: Record<string, TaskStatus> = {
  pending: 'ready-to-implement',
  unblocked: 'ready-to-implement',
  'needs-changes': 'ready-to-implement',
  'in-progress': 'agent-implementing',
  review: 'agent-reviewing',
  'needs-refinement': 'needs-refinement',
  blocked: 'blocked',
  approved: 'ready-to-merge',
};

const STATUS_WEIGHT: Record<TaskStatus, number> = {
  'ready-to-merge': 100,
  'agent-crashed': 90,
  blocked: 80,
  'needs-refinement': 70,
  'ready-to-implement': 50,
  'agent-implementing': 50,
  'agent-reviewing': 50,
};

const PRIORITY_WEIGHT: Record<Priority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const ACTION_STATUSES: Set<TaskStatus> = new Set([
  'ready-to-merge',
  'agent-crashed',
  'blocked',
  'needs-refinement',
  'ready-to-implement',
]);

export function deriveStatus(task: Pick<Task, 'agent' | 'statusLabel'>): TaskStatus | null {
  // Step 1 — Crash override
  if (task.agent !== null && task.agent.crash !== undefined) {
    return 'agent-crashed';
  }

  // Step 2 — Running agent override
  if (task.agent?.running) {
    return match(task.agent.type)
      .with('implementor', () => 'agent-implementing' as const)
      .with('reviewer', () => 'agent-reviewing' as const)
      .exhaustive();
  }

  // Step 3 — Status label mapping
  const mapped = STATUS_LABEL_MAP[task.statusLabel];
  return mapped ?? null;
}

export function parsePriority(priorityLabel: string): Priority | null {
  const PRIORITY_MAP: Record<string, Priority> = {
    'priority:high': 'high',
    'priority:medium': 'medium',
    'priority:low': 'low',
  };
  return PRIORITY_MAP[priorityLabel] ?? null;
}

export function createTUIStore(config: CreateTUIStoreConfig): StoreApi<TUIStore> {
  const { engine } = config;

  const store = createStore<TUIStore>((set, get) => ({
    tasks: new Map(),
    plannerStatus: 'idle',
    selectedIssue: null,
    pinnedTask: null,
    focusedPane: 'taskList',
    shuttingDown: false,
    agentStreams: new Map(),
    issueDetailCache: new Map(),
    prDetailCache: new Map(),

    dispatch(issueNumber: number): void {
      const task = get().tasks.get(issueNumber);
      if (!task) {
        return;
      }

      match(task.status)
        .with('ready-to-implement', () => {
          engine.send({ command: 'dispatchImplementor', issueNumber });
        })
        .with('agent-crashed', () => {
          if (!task.agent) {
            return;
          }
          match(task.agent.type)
            .with('implementor', () => {
              engine.send({ command: 'dispatchImplementor', issueNumber });
            })
            .with('reviewer', () => {
              engine.send({ command: 'dispatchReviewer', issueNumber });
            })
            .exhaustive();
        })
        .otherwise(() => {
          // No-op for other statuses
        });
    },

    cancelAgent(issueNumber: number): void {
      engine.send({ command: 'cancelAgent', issueNumber });
    },

    shutdown(): void {
      set({ shuttingDown: true });
      engine.send({ command: 'shutdown' });
    },

    selectIssue(issueNumber: number): void {
      set({ selectedIssue: issueNumber });
    },

    pinTask(issueNumber: number): void {
      set({ pinnedTask: issueNumber });
      // Trigger on-demand fetch if not cached — fire-and-forget
      fetchIssueDetailIfNeeded(issueNumber).catch(() => {
        // Fetch failure is non-fatal
      });
      fetchPRDetailsIfNeeded(issueNumber).catch(() => {
        // Fetch failure is non-fatal
      });
    },

    cycleFocus(): void {
      const current = get().focusedPane;
      set({ focusedPane: current === 'taskList' ? 'detailPane' : 'taskList' });
    },
  }));

  engine.on((event) => {
    handleEngineEvent(event);
  });

  function handleEngineEvent(event: EngineEvent): void {
    match(event)
      .with({ type: 'issueStatusChanged' }, (e) => {
        handleIssueStatusChanged(e);
      })
      .with({ type: 'prLinked' }, (e) => {
        handlePRLinked(e);
      })
      .with({ type: 'ciStatusChanged' }, (e) => {
        handleCIStatusChanged(e);
      })
      .with({ type: 'agentStarted' }, (e) => {
        handleAgentStarted(e);
      })
      .with({ type: 'agentCompleted' }, (e) => {
        handleAgentCompleted(e);
      })
      .with({ type: 'agentFailed' }, (e) => {
        handleAgentFailed(e);
      })
      .with({ type: 'specChanged' }, () => {
        // No task or store state update
      })
      .exhaustive();
  }

  function handleIssueStatusChanged(e: Extract<EngineEvent, { type: 'issueStatusChanged' }>): void {
    const state = store.getState();

    // Task removal: newStatus is null
    if (e.newStatus === null) {
      const existing = state.tasks.get(e.issueNumber);
      if (!existing) {
        return;
      }

      const tasks = new Map(state.tasks);
      tasks.delete(e.issueNumber);

      // Clear caches
      const issueDetailCache = new Map(state.issueDetailCache);
      issueDetailCache.delete(e.issueNumber);

      const prDetailCache = new Map(state.prDetailCache);
      for (const pr of existing.prs) {
        prDetailCache.delete(pr.number);
      }

      // Clear agent stream
      const agentStreams = new Map(state.agentStreams);
      if (existing.agent) {
        agentStreams.delete(existing.agent.sessionID);
      }

      // Handle pinnedTask
      const pinnedTask = state.pinnedTask === e.issueNumber ? null : state.pinnedTask;

      // Handle selectedIssue
      let selectedIssue = state.selectedIssue;
      if (selectedIssue === e.issueNumber) {
        selectedIssue = findNextSelectedIssue(tasks);
      }

      store.setState({
        tasks,
        issueDetailCache,
        prDetailCache,
        agentStreams,
        pinnedTask,
        selectedIssue,
      });
      return;
    }

    // Task create/update
    const tasks = new Map(state.tasks);
    const existing = tasks.get(e.issueNumber);

    const shouldPreserveAgent = e.isRecovery === true || e.isEngineTransition === true;
    const agent = shouldPreserveAgent ? (existing?.agent ?? null) : null;

    const taskData: Task = {
      issueNumber: e.issueNumber,
      title: e.title,
      status: 'ready-to-implement', // placeholder, derived below
      statusLabel: e.newStatus,
      priority: parsePriority(e.priorityLabel),
      agentCount: existing?.agentCount ?? 0,
      createdAt: e.createdAt,
      prs: existing?.prs ?? [],
      agent,
    };

    const derivedStatus = deriveStatus(taskData);
    if (derivedStatus !== null) {
      taskData.status = derivedStatus;
    }

    tasks.set(e.issueNumber, taskData);

    // Mark issue detail cache as stale
    const issueDetailCache = markCacheStale(state.issueDetailCache, e.issueNumber);

    store.setState({ tasks, issueDetailCache });
  }

  function handlePRLinked(e: Extract<EngineEvent, { type: 'prLinked' }>): void {
    const state = store.getState();
    const existing = state.tasks.get(e.issueNumber);
    if (!existing) {
      return;
    }

    const tasks = new Map(state.tasks);
    const prs = [...existing.prs];
    const prIndex = prs.findIndex((pr) => pr.number === e.prNumber);

    if (prIndex >= 0) {
      prs[prIndex] = { number: e.prNumber, url: e.url, ciStatus: e.ciStatus };
    } else {
      prs.push({ number: e.prNumber, url: e.url, ciStatus: e.ciStatus });
    }

    tasks.set(e.issueNumber, { ...existing, prs });

    // Mark PR detail cache as stale
    const prDetailCache = markCacheStale(state.prDetailCache, e.prNumber);

    store.setState({ tasks, prDetailCache });
  }

  function handleCIStatusChanged(e: Extract<EngineEvent, { type: 'ciStatusChanged' }>): void {
    if (e.issueNumber === undefined) {
      return;
    }

    const state = store.getState();
    const existing = state.tasks.get(e.issueNumber);
    if (!existing) {
      return;
    }

    const tasks = new Map(state.tasks);
    const prs = [...existing.prs];
    const prIndex = prs.findIndex((pr) => pr.number === e.prNumber);

    if (prIndex >= 0) {
      const existingPR = prs[prIndex];
      if (existingPR) {
        prs[prIndex] = { number: existingPR.number, url: existingPR.url, ciStatus: e.newCIStatus };
      }
    } else {
      // Create partial PR entry
      prs.push({ number: e.prNumber, url: '', ciStatus: e.newCIStatus });
    }

    tasks.set(e.issueNumber, { ...existing, prs });

    // Mark PR detail cache as stale
    const prDetailCache = markCacheStale(state.prDetailCache, e.prNumber);

    store.setState({ tasks, prDetailCache });
  }

  function handleAgentStarted(e: Extract<EngineEvent, { type: 'agentStarted' }>): void {
    // Planner events toggle plannerStatus, no task update
    if (e.agentType === 'planner') {
      store.setState({ plannerStatus: 'running' });
      return;
    }

    // Implementor / Reviewer
    if (e.issueNumber === undefined) {
      return;
    }

    const state = store.getState();
    const existing = state.tasks.get(e.issueNumber);
    if (!existing) {
      return;
    }

    const agentType = e.agentType as AgentType;
    const tasks = new Map(state.tasks);

    const updatedTask: Task = {
      ...existing,
      agentCount: existing.agentCount + 1,
      agent: buildTaskAgent({
        type: agentType,
        running: true,
        sessionID: e.sessionID,
        branchName: e.branchName,
        logFilePath: e.logFilePath,
      }),
      status: existing.status, // placeholder, derived below
    };

    const derivedStatus = deriveStatus(updatedTask);
    if (derivedStatus !== null) {
      updatedTask.status = derivedStatus;
    }

    tasks.set(e.issueNumber, updatedTask);

    // Subscribe to agent stream, clear existing buffer for this session
    const agentStreams = new Map(state.agentStreams);
    agentStreams.set(e.sessionID, []);

    store.setState({ tasks, agentStreams });

    subscribeToAgentStream(e.sessionID).catch(() => {
      // Stream subscription failure is non-fatal
    });
  }

  function handleAgentCompleted(e: Extract<EngineEvent, { type: 'agentCompleted' }>): void {
    if (e.agentType === 'planner') {
      store.setState({ plannerStatus: 'idle' });
      return;
    }

    // Find task by sessionID
    const state = store.getState();
    const taskEntry = findTaskBySessionID(state.tasks, e.sessionID);
    if (!taskEntry) {
      return;
    }

    const [issueNumber, existing] = taskEntry;
    if (!existing.agent) {
      return;
    }

    const tasks = new Map(state.tasks);
    const updatedAgent = { ...existing.agent, running: false };
    const updatedTask: Task = { ...existing, agent: updatedAgent, status: existing.status };

    const derivedStatus = deriveStatus(updatedTask);
    if (derivedStatus !== null) {
      updatedTask.status = derivedStatus;
    }

    tasks.set(issueNumber, updatedTask);
    store.setState({ tasks });
  }

  function handleAgentFailed(e: Extract<EngineEvent, { type: 'agentFailed' }>): void {
    if (e.agentType === 'planner') {
      store.setState({ plannerStatus: 'idle' });
      return;
    }

    // Find task by sessionID
    const state = store.getState();
    const taskEntry = findTaskBySessionID(state.tasks, e.sessionID);
    if (!taskEntry) {
      return;
    }

    const [issueNumber, existing] = taskEntry;
    if (!existing.agent) {
      return;
    }

    const tasks = new Map(state.tasks);
    const updatedAgent = {
      ...existing.agent,
      running: false,
      crash: { error: e.error },
    };
    const updatedTask: Task = { ...existing, agent: updatedAgent, status: existing.status };

    const derivedStatus = deriveStatus(updatedTask);
    if (derivedStatus !== null) {
      updatedTask.status = derivedStatus;
    }

    tasks.set(issueNumber, updatedTask);
    store.setState({ tasks });
  }

  async function subscribeToAgentStream(sessionID: string): Promise<void> {
    const stream = engine.getAgentStream(sessionID);
    if (!stream) {
      return;
    }

    try {
      for await (const chunk of stream) {
        const lines = splitChunkIntoLines(chunk);
        if (lines.length > 0) {
          appendStreamLines(sessionID, lines);
        }
      }
    } catch {
      // Stream consumption failure is non-fatal
    }
  }

  function appendStreamLines(sessionID: string, lines: string[]): void {
    const state = store.getState();
    const agentStreams = new Map(state.agentStreams);
    const buffer = [...(agentStreams.get(sessionID) ?? []), ...lines];

    const overflow = buffer.length - STREAM_BUFFER_LIMIT;

    if (overflow > 0) {
      buffer.splice(0, overflow);
    }

    agentStreams.set(sessionID, buffer);
    store.setState({ agentStreams });
  }

  async function fetchIssueDetailIfNeeded(issueNumber: number): Promise<void> {
    const state = store.getState();
    const cached = state.issueDetailCache.get(issueNumber);

    if (cached && !cached.stale) {
      return;
    }

    try {
      const result = await engine.getIssueDetails(issueNumber);
      const current = store.getState();
      const issueDetailCache = new Map(current.issueDetailCache);
      issueDetailCache.set(issueNumber, {
        body: result.body,
        labels: result.labels,
        stale: false,
      });
      store.setState({ issueDetailCache });
    } catch {
      // Fetch failure is non-fatal; cache remains empty or stale for next retry
    }
  }

  async function fetchPRDetailsIfNeeded(issueNumber: number): Promise<void> {
    const state = store.getState();
    const task = state.tasks.get(issueNumber);
    if (!task) {
      return;
    }

    const prsToFetch = task.prs.filter((pr) => {
      const cached = state.prDetailCache.get(pr.number);
      return !cached || cached.stale;
    });

    const fetchPromises = prsToFetch.map(async (pr) => {
      try {
        const result = await engine.getPRForIssue(issueNumber);
        if (result) {
          const current = store.getState();
          const prDetailCache = new Map(current.prDetailCache);
          prDetailCache.set(pr.number, {
            title: result.title,
            changedFilesCount: result.changedFilesCount,
            stale: false,
          });
          store.setState({ prDetailCache });
        }
      } catch {
        // Fetch failure is non-fatal
      }
    });

    await Promise.all(fetchPromises);
  }

  return store;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const selectSortedTasks: (tasks: Map<number, Task>) => SortedTask[] = memoizee(
  function computeSortedTasks(tasks: Map<number, Task>): SortedTask[] {
    const actionTasks: SortedTask[] = [];
    const agentsTasks: SortedTask[] = [];

    for (const task of tasks.values()) {
      const derivedStatus = deriveStatus(task);
      if (derivedStatus !== null) {
        const section: Section = ACTION_STATUSES.has(derivedStatus) ? 'action' : 'agents';
        const sortedTask: SortedTask = { task, section };

        if (section === 'action') {
          actionTasks.push(sortedTask);
        } else {
          agentsTasks.push(sortedTask);
        }
      }
    }

    const sortFn = (a: SortedTask, b: SortedTask): number => {
      const aStatusWeight = STATUS_WEIGHT[a.task.status] ?? 0;
      const bStatusWeight = STATUS_WEIGHT[b.task.status] ?? 0;

      // Status weight descending
      if (aStatusWeight !== bStatusWeight) {
        return bStatusWeight - aStatusWeight;
      }

      // Priority weight descending
      const aPriorityWeight =
        a.task.priority !== null ? (PRIORITY_WEIGHT[a.task.priority] ?? 0) : 0;
      const bPriorityWeight =
        b.task.priority !== null ? (PRIORITY_WEIGHT[b.task.priority] ?? 0) : 0;
      if (aPriorityWeight !== bPriorityWeight) {
        return bPriorityWeight - aPriorityWeight;
      }

      // Issue number ascending
      return a.task.issueNumber - b.task.issueNumber;
    };

    actionTasks.sort(sortFn);
    agentsTasks.sort(sortFn);

    return [...actionTasks, ...agentsTasks];
  },
  { max: 1 },
);

export function selectActionCount(state: TUIState): number {
  let count = 0;
  for (const task of state.tasks.values()) {
    const derivedStatus = deriveStatus(task);
    if (derivedStatus !== null && ACTION_STATUSES.has(derivedStatus)) {
      count += 1;
    }
  }
  return count;
}

export function selectAgentSectionCount(state: TUIState): number {
  let count = 0;
  for (const task of state.tasks.values()) {
    const derivedStatus = deriveStatus(task);
    if (derivedStatus !== null && !ACTION_STATUSES.has(derivedStatus)) {
      count += 1;
    }
  }
  return count;
}

export function selectRunningAgentCount(state: TUIState): number {
  let count = 0;
  for (const task of state.tasks.values()) {
    if (task.agent?.running === true) {
      count += 1;
    }
  }
  if (state.plannerStatus === 'running') {
    count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTaskBySessionID(tasks: Map<number, Task>, sessionID: string): [number, Task] | null {
  for (const [issueNumber, task] of tasks) {
    if (task.agent?.sessionID === sessionID) {
      return [issueNumber, task];
    }
  }
  return null;
}

function findNextSelectedIssue(tasks: Map<number, Task>): number | null {
  // Build sorted list to find "next" task
  const sorted = selectSortedTasks(tasks);

  if (sorted.length === 0) {
    return null;
  }

  // Return the first task in sort order
  return sorted[0]?.task.issueNumber ?? null;
}

function markCacheStale<T extends { stale: boolean }>(
  cache: Map<number, T>,
  key: number,
): Map<number, T> {
  const entry = cache.get(key);
  if (!entry) {
    return cache;
  }
  const updated = new Map(cache);
  updated.set(key, { ...entry, stale: true });
  return updated;
}

interface BuildTaskAgentParams {
  type: AgentType;
  running: boolean;
  sessionID: string;
  branchName: string | undefined;
  logFilePath: string | undefined;
}

function buildTaskAgent(params: BuildTaskAgentParams): TaskAgent {
  const agent: TaskAgent = {
    type: params.type,
    running: params.running,
    sessionID: params.sessionID,
  };
  if (params.branchName !== undefined) {
    agent.branchName = params.branchName;
  }
  if (params.logFilePath !== undefined) {
    agent.logFilePath = params.logFilePath;
  }
  return agent;
}

function splitChunkIntoLines(chunk: string): string[] {
  const parts = chunk.split('\n');
  if (parts.length > 0 && parts.at(-1) === '') {
    parts.pop();
  }
  return parts;
}
