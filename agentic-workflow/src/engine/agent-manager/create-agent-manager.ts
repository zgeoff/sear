import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import invariant from 'tiny-invariant';
import { match, P } from 'ts-pattern';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentStartedEvent,
  AgentStream,
  AgentType,
} from '../../types.ts';
import type {
  AgentManager,
  AgentManagerDeps,
  AgentSessionTracker,
  DispatchImplementorParams,
  DispatchPlannerParams,
  DispatchReviewerParams,
  OutputListener,
} from './types.ts';

const SECONDS_TO_MS = 1000;

interface SessionLogger {
  logFilePath: string;
  disabled: boolean;
}

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const {
    emitter,
    worktreeManager,
    repoRoot,
    agentPlanner,
    agentImplementor,
    agentReviewer,
    maxAgentDuration,
    queryFactory,
    loggingEnabled,
    logsDir,
    logError,
    logInfo,
    execCommand,
  } = deps;

  const issueAgents = new Map<number, AgentSessionTracker>();
  const sessionTrackers = new Map<string, AgentSessionTracker>();
  let plannerSession: AgentSessionTracker | null = null;

  // Per-session logging state, keyed by tracker reference identity
  const sessionLoggers = new WeakMap<AgentSessionTracker, SessionLogger>();

  return {
    async dispatchImplementor(params: DispatchImplementorParams): Promise<void> {
      const { issueNumber, branchName } = params;

      if (issueAgents.has(issueNumber)) {
        logInfo(`Skipping implementor dispatch for issue #${issueNumber}: agent already running`);
        return;
      }

      const worktreeResult = await worktreeManager.createForBranch({
        branchName,
        ...(params.branchBase !== undefined && { branchBase: params.branchBase }),
      });

      try {
        await execCommand(worktreeResult.worktreePath, 'yarn', ['install']);
      } catch {
        await worktreeManager.removeByPath(worktreeResult.worktreePath).catch(() => {
          // Worktree removal failure is non-fatal
        });
        emitter.emit(
          buildFailedEventForYarnInstall(
            'implementor',
            issueNumber,
            worktreeResult.branch,
            'yarn install failed',
          ),
        );
        return;
      }

      const tracker = await startSession({
        agentType: 'implementor',
        prompt: params.prompt,
        cwd: worktreeResult.worktreePath,
        agent: agentImplementor,
        issueNumber,
        worktreePath: worktreeResult.worktreePath,
        branchName: worktreeResult.branch,
        ...(params.modelOverride !== undefined && { modelOverride: params.modelOverride }),
      });

      issueAgents.set(issueNumber, tracker);

      monitorSession(tracker, () => {
        issueAgents.delete(issueNumber);
      });
    },

    async dispatchReviewer(params: DispatchReviewerParams): Promise<void> {
      const { issueNumber, branchName, prompt } = params;

      if (issueAgents.has(issueNumber)) {
        logInfo(`Skipping reviewer dispatch for issue #${issueNumber}: agent already running`);
        return;
      }

      const worktreeResult = await worktreeManager.createForBranch({
        branchName,
        ...(params.fetchRemote === true && { fetchRemote: true }),
      });

      try {
        await execCommand(worktreeResult.worktreePath, 'yarn', ['install']);
      } catch {
        await worktreeManager.removeByPath(worktreeResult.worktreePath).catch(() => {
          // Worktree removal failure is non-fatal
        });
        emitter.emit(
          buildFailedEventForYarnInstall(
            'reviewer',
            issueNumber,
            worktreeResult.branch,
            'yarn install failed',
          ),
        );
        return;
      }

      const tracker = await startSession({
        agentType: 'reviewer',
        prompt,
        cwd: worktreeResult.worktreePath,
        agent: agentReviewer,
        issueNumber,
        worktreePath: worktreeResult.worktreePath,
        branchName: worktreeResult.branch,
      });

      issueAgents.set(issueNumber, tracker);

      monitorSession(tracker, () => {
        issueAgents.delete(issueNumber);
      });
    },

    async dispatchPlanner(params: DispatchPlannerParams): Promise<void> {
      const { specPaths } = params;

      if (plannerSession) {
        logInfo('Skipping planner dispatch: planner already running');
        return;
      }

      const tracker = await startSession({
        agentType: 'planner',
        prompt: params.prompt ?? specPaths.join(' '),
        cwd: repoRoot,
        agent: agentPlanner,
        specPaths,
      });

      plannerSession = tracker;

      monitorSession(tracker, () => {
        plannerSession = null;
      });
    },

    async cancelAgent(issueNumber: number): Promise<void> {
      const tracker = issueAgents.get(issueNumber);
      if (!tracker) {
        return;
      }

      await cancelSession(tracker, 'Cancelled by user');
    },

    async cancelPlanner(): Promise<void> {
      if (!plannerSession) {
        return;
      }

      await cancelSession(plannerSession, 'Cancelled by user');
    },

    getAgentStream(sessionID: string): AgentStream {
      const tracker = sessionTrackers.get(sessionID);
      if (!tracker) {
        return null;
      }

      return buildAsyncIterable(tracker);
    },

    isRunning(issueNumber: number): boolean {
      return issueAgents.has(issueNumber);
    },

    isPlannerRunning(): boolean {
      return plannerSession !== null;
    },

    getRunningSessionIDs(): string[] {
      const ids: string[] = [];
      for (const tracker of issueAgents.values()) {
        ids.push(tracker.sessionID);
      }
      if (plannerSession) {
        ids.push(plannerSession.sessionID);
      }
      return ids;
    },

    async cancelAll(): Promise<void> {
      const cancellations: Promise<void>[] = [];
      for (const tracker of issueAgents.values()) {
        cancellations.push(cancelSession(tracker, 'Shutdown'));
      }
      if (plannerSession) {
        cancellations.push(cancelSession(plannerSession, 'Shutdown'));
      }
      await Promise.all(cancellations);
    },
  };

  async function startSession(params: StartSessionParams): Promise<AgentSessionTracker> {
    const abortController = new AbortController();

    const queryHandle = await queryFactory({
      prompt: params.prompt,
      agent: params.agent,
      cwd: params.cwd,
      abortController,
      ...(params.modelOverride !== undefined && { modelOverride: params.modelOverride }),
    });

    const tracker: AgentSessionTracker = {
      agentType: params.agentType,
      sessionID: '', // populated from init message
      query: queryHandle,
      abortController,
      timer: setTimeout(async () => {
        try {
          await cancelSession(tracker, `Agent exceeded max duration of ${maxAgentDuration}s`);
        } catch (error) {
          logError('Timeout cancel failed', error);
        }
      }, maxAgentDuration * SECONDS_TO_MS),
      outputChunks: [],
      outputListeners: new Set(),
      done: false,
      ...(params.worktreePath !== undefined && { worktreePath: params.worktreePath }),
      ...(params.branchName !== undefined && { branchName: params.branchName }),
      ...(params.issueNumber !== undefined && { issueNumber: params.issueNumber }),
      ...(params.specPaths !== undefined && { specPaths: params.specPaths }),
    };

    return tracker;
  }

  function monitorSession(tracker: AgentSessionTracker, onCleanup: () => void): void {
    consumeMessages(tracker, onCleanup).catch(() => {
      // Error handling is done inside consumeMessages
    });
  }

  async function consumeMessages(
    tracker: AgentSessionTracker,
    onCleanup: () => void,
  ): Promise<void> {
    let sessionSucceeded = false;
    let errorMessage: string | undefined;

    try {
      for await (const message of tracker.query) {
        await processMessage(tracker, message);
      }

      // If we reach here without a result message, treat as success
      sessionSucceeded = !errorMessage;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    // Check if we already got a result message that set the outcome
    if (tracker.done) {
      return;
    }

    await finishSession(tracker, sessionSucceeded, errorMessage, onCleanup);
  }

  async function processMessage(tracker: AgentSessionTracker, message: unknown): Promise<void> {
    await match(message)
      .with({ type: 'system', subtype: 'init', session_id: P.string }, async (msg) => {
        tracker.sessionID = msg.session_id;
        sessionTrackers.set(msg.session_id, tracker);

        if (loggingEnabled) {
          await initializeLogFile(tracker, msg);
        }

        const logger = sessionLoggers.get(tracker);
        const logFilePath = logger ? logger.logFilePath : undefined;

        emitter.emit(buildStartedEvent(tracker, logFilePath));
      })
      .with({ type: 'assistant', message: { content: P.any } }, async (msg) => {
        const text = extractTextFromAssistantMessage(msg.message);
        if (text) {
          tracker.outputChunks.push(text);
          for (const listener of tracker.outputListeners) {
            listener(text);
          }
        }

        await logAssistantMessage(tracker, msg.message);
      })
      .with({ type: 'result', subtype: 'success' }, async (msg) => {
        await logResultMessage(tracker, 'success', extractResultMetadata(msg));
        await writeLogFooter(tracker, 'completed');
        await finishSession(tracker, true, undefined, () => {
          removeFromTracking(tracker);
        });
      })
      .with(
        { type: 'result', subtype: P.union('error_max_turns', 'error_during_execution') },
        async (msg) => {
          await logResultMessage(tracker, msg.subtype, extractResultMetadata(msg));
          await writeLogFooter(tracker, 'failed');
          await finishSession(tracker, false, 'Agent session ended with error', () => {
            removeFromTracking(tracker);
          });
        },
      )
      .otherwise(async (msg) => {
        await logUnknownMessage(tracker, msg);
      });
  }

  async function finishSession(
    tracker: AgentSessionTracker,
    succeeded: boolean,
    errorMessage: string | undefined,
    onCleanup: () => void,
  ): Promise<void> {
    if (tracker.done) {
      return;
    }
    tracker.done = true;

    clearTimeout(tracker.timer);
    if (tracker.sessionID) {
      sessionTrackers.delete(tracker.sessionID);
    }
    onCleanup();

    // Notify stream listeners that the stream is done
    for (const listener of tracker.outputListeners) {
      listener('');
    }
    tracker.outputListeners.clear();

    const logger = sessionLoggers.get(tracker);
    const logFilePath = logger ? logger.logFilePath : undefined;

    if (succeeded) {
      emitter.emit(buildCompletedEvent(tracker, logFilePath));

      if (
        (tracker.agentType === 'implementor' || tracker.agentType === 'reviewer') &&
        tracker.worktreePath !== undefined
      ) {
        worktreeManager.removeByPath(tracker.worktreePath).catch(() => {
          // Worktree cleanup failure is non-fatal
        });
      }
      return;
    }

    emitter.emit(buildFailedEvent(tracker, errorMessage ?? 'Unknown error', logFilePath));

    if (
      (tracker.agentType === 'implementor' || tracker.agentType === 'reviewer') &&
      tracker.worktreePath !== undefined
    ) {
      worktreeManager.removeByPath(tracker.worktreePath).catch(() => {
        // Worktree cleanup failure is non-fatal
      });
    }
  }

  function removeFromTracking(tracker: AgentSessionTracker): void {
    if (tracker.agentType === 'planner') {
      if (plannerSession === tracker) {
        plannerSession = null;
      }
      return;
    }

    if (tracker.issueNumber !== undefined) {
      issueAgents.delete(tracker.issueNumber);
    }
  }

  async function cancelSession(tracker: AgentSessionTracker, reason: string): Promise<void> {
    if (tracker.done) {
      return;
    }

    tracker.abortController.abort();
    tracker.query.interrupt().catch(() => {
      // Interrupt may fail if the session is already done
    });

    await writeLogFooter(tracker, 'cancelled');
    await finishSession(tracker, false, reason, () => {
      removeFromTracking(tracker);
    });
  }

  // ---------------------------------------------------------------------------
  // Session logging helpers
  // ---------------------------------------------------------------------------

  async function initializeLogFile(
    tracker: AgentSessionTracker,
    initMessage: InitMessageShape,
  ): Promise<void> {
    const context = buildLogFileContext(tracker);
    const timestamp = Date.now();
    const fileName = context
      ? `${timestamp}-${tracker.agentType}-${context}.log`
      : `${timestamp}-${tracker.agentType}.log`;
    const filePath = `${logsDir}/${fileName}`;

    try {
      await mkdir(logsDir, { recursive: true });

      const header = buildSessionHeader(tracker, initMessage);
      await writeFile(filePath, header);

      sessionLoggers.set(tracker, { logFilePath: filePath, disabled: false });
    } catch {
      // Log file creation failure is non-fatal — skip logging for this session
    }
  }

  async function logAssistantMessage(
    tracker: AgentSessionTracker,
    message: AssistantMessageContent,
  ): Promise<void> {
    const logger = sessionLoggers.get(tracker);
    if (!logger || logger.disabled) {
      return;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      return;
    }

    const lines: string[] = [];
    const timestamp = formatUtcTime(new Date());

    for (const block of content) {
      if (typeof block !== 'object' || block === null || !('type' in block)) {
        // Skip non-object or untyped blocks
      } else if (block.type === 'text' && isTextBlock(block)) {
        lines.push(`[${timestamp}] ASSISTANT`);
        const indented = block.text
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n');
        lines.push(indented);
        lines.push('');
      } else if (block.type === 'tool_use' && isToolUseBlock(block)) {
        lines.push(`[${timestamp}] ASSISTANT`);
        lines.push(`  [tool_use] ${block.name}`);
        lines.push('');
      }
    }

    if (lines.length === 0) {
      return;
    }

    await appendToLog(tracker, lines.join('\n'));
  }

  async function logResultMessage(
    tracker: AgentSessionTracker,
    subtype: string,
    message: ResultMessageShape,
  ): Promise<void> {
    const logger = sessionLoggers.get(tracker);
    if (!logger || logger.disabled) {
      return;
    }

    const timestamp = formatUtcTime(new Date());
    const lines: string[] = [];
    lines.push(`[${timestamp}] RESULT ${subtype}`);

    if (message.duration_ms !== undefined) {
      lines.push(`  Duration: ${(message.duration_ms / SECONDS_TO_MS).toFixed(1)}s`);
    }
    if (message.total_cost_usd !== undefined) {
      lines.push(`  Cost:     $${message.total_cost_usd.toFixed(2)}`);
    }
    if (message.num_turns !== undefined) {
      lines.push(`  Turns:    ${message.num_turns}`);
    }
    if (message.usage !== undefined) {
      lines.push(
        `  Tokens:   ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`,
      );
    }

    lines.push('');
    await appendToLog(tracker, lines.join('\n'));
  }

  async function logUnknownMessage(tracker: AgentSessionTracker, message: unknown): Promise<void> {
    const logger = sessionLoggers.get(tracker);
    if (!logger || logger.disabled) {
      return;
    }

    const type = isTypedMessage(message) ? String(message.type) : 'unknown';
    const timestamp = formatUtcTime(new Date());

    const lines: string[] = [];
    lines.push(`[${timestamp}] UNKNOWN ${type}`);
    lines.push(`  ${JSON.stringify(message)}`);
    lines.push('');

    await appendToLog(tracker, lines.join('\n'));
  }

  async function writeLogFooter(tracker: AgentSessionTracker, outcome: string): Promise<void> {
    const logger = sessionLoggers.get(tracker);
    if (!logger || logger.disabled) {
      return;
    }

    const now = new Date();
    const lines: string[] = [];
    lines.push('=== Session End ===');
    lines.push(`Outcome:  ${outcome}`);
    lines.push(`Finished: ${now.toISOString()}`);
    lines.push('');

    await appendToLog(tracker, lines.join('\n'));
  }

  async function appendToLog(tracker: AgentSessionTracker, content: string): Promise<void> {
    const logger = sessionLoggers.get(tracker);
    if (!logger || logger.disabled) {
      return;
    }

    try {
      await appendFile(logger.logFilePath, content);
    } catch (error) {
      // Write failure is non-fatal — disable logging for the remainder of this session
      logger.disabled = true;
      logError('Agent session log write failed', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface StartSessionParams {
  agentType: AgentType;
  prompt: string;
  cwd: string;
  agent: string;
  issueNumber?: number;
  specPaths?: string[];
  worktreePath?: string;
  branchName?: string;
  modelOverride?: 'sonnet' | 'opus' | 'haiku';
}

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
}

function isTextBlock(block: object): block is TextBlock {
  return (
    'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string'
  );
}

function isToolUseBlock(block: object): block is ToolUseBlock {
  return (
    'type' in block &&
    block.type === 'tool_use' &&
    'name' in block &&
    typeof block.name === 'string'
  );
}

function isTypedMessage(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function isToolEntry(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
  );
}

function isUsage(value: unknown): value is ResultMessageUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'input_tokens' in value &&
    typeof value.input_tokens === 'number' &&
    'output_tokens' in value &&
    typeof value.output_tokens === 'number'
  );
}

interface AssistantMessageContent {
  content: unknown;
}

interface InitMessageShape {
  session_id: string;
  model?: string;
  cwd?: string;
  tools?: Array<{ name?: string } | string>;
}

interface ResultMessageUsage {
  input_tokens: number;
  output_tokens: number;
}

interface ResultMessageShape {
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: ResultMessageUsage;
}

// ---------------------------------------------------------------------------
// Pure helpers (below the primary export)
// ---------------------------------------------------------------------------

function buildAsyncIterable(tracker: AgentSessionTracker): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let chunkIndex = 0;

      return {
        async next(): Promise<IteratorResult<string>> {
          // Yield any buffered chunks first
          if (chunkIndex < tracker.outputChunks.length) {
            const value = tracker.outputChunks[chunkIndex];
            invariant(value !== undefined, 'chunk must exist at index within bounds');
            chunkIndex += 1;
            return { value, done: false };
          }

          // If the session is done, we're done
          if (tracker.done) {
            return { value: undefined, done: true as const };
          }

          // Wait for the next chunk
          return new Promise<IteratorResult<string>>((resolve) => {
            const listener: OutputListener = (chunk: string): void => {
              tracker.outputListeners.delete(listener);
              if (chunk === '' || tracker.done) {
                resolve({ value: undefined, done: true as const });
                return;
              }
              chunkIndex += 1;
              resolve({ value: chunk, done: false });
            };
            tracker.outputListeners.add(listener);
          });
        },
      };
    },
  };
}

function extractTextFromAssistantMessage(message: { content: unknown }): string {
  const { content } = message;

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && isTextBlock(block)) {
      textParts.push(block.text);
    }
  }

  return textParts.join('');
}

function buildStartedEvent(
  tracker: AgentSessionTracker,
  logFilePath: string | undefined,
): AgentStartedEvent {
  return {
    type: 'agentStarted',
    agentType: tracker.agentType,
    sessionID: tracker.sessionID,
    ...(tracker.issueNumber !== undefined && { issueNumber: tracker.issueNumber }),
    ...(tracker.specPaths && { specPaths: tracker.specPaths }),
    ...((tracker.agentType === 'implementor' || tracker.agentType === 'reviewer') &&
      tracker.branchName && { branchName: tracker.branchName }),
    ...(logFilePath !== undefined && { logFilePath }),
  };
}

function buildCompletedEvent(
  tracker: AgentSessionTracker,
  logFilePath: string | undefined,
): AgentCompletedEvent {
  return {
    type: 'agentCompleted',
    agentType: tracker.agentType,
    sessionID: tracker.sessionID,
    ...(tracker.issueNumber !== undefined && { issueNumber: tracker.issueNumber }),
    ...(tracker.specPaths && { specPaths: tracker.specPaths }),
    ...(logFilePath !== undefined && { logFilePath }),
  };
}

function buildFailedEvent(
  tracker: AgentSessionTracker,
  error: string,
  logFilePath: string | undefined,
): AgentFailedEvent {
  return {
    type: 'agentFailed',
    agentType: tracker.agentType,
    sessionID: tracker.sessionID,
    error,
    ...(tracker.issueNumber !== undefined && { issueNumber: tracker.issueNumber }),
    ...(tracker.specPaths && { specPaths: tracker.specPaths }),
    ...((tracker.agentType === 'implementor' || tracker.agentType === 'reviewer') &&
      tracker.branchName && { branchName: tracker.branchName }),
    ...(logFilePath !== undefined && { logFilePath }),
  };
}

function buildLogFileContext(tracker: AgentSessionTracker): string | undefined {
  if (tracker.agentType === 'planner') {
    return;
  }
  if (tracker.issueNumber !== undefined) {
    return String(tracker.issueNumber);
  }
  return;
}

function buildSessionHeader(tracker: AgentSessionTracker, initMessage: InitMessageShape): string {
  const lines: string[] = [];
  lines.push('=== Agent Session ===');
  lines.push(`Type:       ${tracker.agentType}`);
  lines.push(`Session ID: ${tracker.sessionID}`);

  if (tracker.agentType === 'planner' && tracker.specPaths) {
    lines.push(`Spec Paths: ${tracker.specPaths.join(', ')}`);
  }
  if (
    (tracker.agentType === 'implementor' || tracker.agentType === 'reviewer') &&
    tracker.issueNumber !== undefined
  ) {
    lines.push(`Issue:      #${tracker.issueNumber}`);
  }

  lines.push(`Started:    ${new Date().toISOString()}`);
  lines.push('');
  lines.push('=== Messages ===');
  lines.push('');

  // Log the init message itself
  const timestamp = formatUtcTime(new Date());
  lines.push(`[${timestamp}] SYSTEM init`);
  if (initMessage.model) {
    lines.push(`  Model: ${initMessage.model}`);
  }
  if (initMessage.cwd) {
    lines.push(`  CWD: ${initMessage.cwd}`);
  }
  if (initMessage.tools && Array.isArray(initMessage.tools)) {
    const toolNames = initMessage.tools
      .map((t) => {
        if (typeof t === 'string') {
          return t;
        }
        if (isToolEntry(t)) {
          return t.name;
        }
        return '';
      })
      .filter(Boolean);
    if (toolNames.length > 0) {
      lines.push(`  Tools: ${toolNames.join(', ')}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function extractResultMetadata(message: Record<string, unknown>): ResultMessageShape {
  const result: ResultMessageShape = {};

  if (typeof message.duration_ms === 'number') {
    result.duration_ms = message.duration_ms;
  }
  if (typeof message.total_cost_usd === 'number') {
    result.total_cost_usd = message.total_cost_usd;
  }
  if (typeof message.num_turns === 'number') {
    result.num_turns = message.num_turns;
  }

  const usage = message.usage;
  if (isUsage(usage)) {
    result.usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
  }

  return result;
}

function formatUtcTime(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function buildFailedEventForYarnInstall(
  agentType: AgentType,
  issueNumber: number,
  branchName: string,
  error: string,
): AgentFailedEvent {
  return {
    type: 'agentFailed',
    agentType,
    sessionID: '',
    error,
    issueNumber,
    branchName,
  };
}
