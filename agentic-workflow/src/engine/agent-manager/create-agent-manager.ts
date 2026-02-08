import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { match, P } from 'ts-pattern';
import type {
  AgentCompletedEvent,
  AgentFailedEvent,
  AgentSkippedEvent,
  AgentStartedEvent,
  AgentType,
} from '../../types.js';
import type {
  AgentManager,
  AgentManagerDeps,
  AgentSessionTracker,
  OutputListener,
} from './types.js';

export function createAgentManager(deps: AgentManagerDeps): AgentManager {
  const {
    emitter,
    worktreeManager,
    repoRoot,
    agentFilePlanner,
    agentFileImplementor,
    agentFileReviewer,
    maxAgentDuration,
    queryFactory,
  } = deps;

  const issueAgents = new Map<number, AgentSessionTracker>();
  let plannerSession: AgentSessionTracker | null = null;

  return {
    async dispatchImplementor(params) {
      const { issueNumber } = params;

      if (issueAgents.has(issueNumber)) {
        emitter.emit(buildSkippedEvent('implementor', { issueNumber }));
        return;
      }

      const worktreeResult = await worktreeManager.createOrReuse(issueNumber);

      const tracker = startSession({
        agentType: 'implementor',
        prompt: String(issueNumber),
        cwd: worktreeResult.worktreePath,
        systemPrompt: agentFileImplementor,
        issueNumber,
        worktreePath: worktreeResult.worktreePath,
      });

      issueAgents.set(issueNumber, tracker);

      monitorSession(tracker, () => {
        issueAgents.delete(issueNumber);
      });
    },

    dispatchReviewer(params) {
      const { issueNumber } = params;

      if (issueAgents.has(issueNumber)) {
        emitter.emit(buildSkippedEvent('reviewer', { issueNumber }));
        return;
      }

      const tracker = startSession({
        agentType: 'reviewer',
        prompt: String(issueNumber),
        cwd: repoRoot,
        systemPrompt: agentFileReviewer,
        issueNumber,
      });

      issueAgents.set(issueNumber, tracker);

      monitorSession(tracker, () => {
        issueAgents.delete(issueNumber);
      });
    },

    dispatchPlanner(params) {
      const { specPaths } = params;

      if (plannerSession) {
        emitter.emit(buildSkippedEvent('planner', { specPaths }));
        return;
      }

      const tracker = startSession({
        agentType: 'planner',
        prompt: specPaths.join(' '),
        cwd: repoRoot,
        systemPrompt: agentFilePlanner,
        specPaths,
      });

      plannerSession = tracker;

      monitorSession(tracker, () => {
        plannerSession = null;
      });
    },

    cancelAgent(issueNumber) {
      const tracker = issueAgents.get(issueNumber);
      if (!tracker) return;

      cancelSession(tracker, 'Cancelled by user');
    },

    cancelPlanner() {
      if (!plannerSession) return;

      cancelSession(plannerSession, 'Cancelled by user');
    },

    getAgentStream(issueNumber) {
      const tracker = issueAgents.get(issueNumber);
      if (!tracker) return null;

      return buildAsyncIterable(tracker);
    },

    isRunning(issueNumber) {
      return issueAgents.has(issueNumber);
    },

    isPlannerRunning() {
      return plannerSession !== null;
    },

    getRunningSessionIDs() {
      const ids: string[] = [];
      for (const tracker of issueAgents.values()) {
        ids.push(tracker.sessionID);
      }
      if (plannerSession) {
        ids.push(plannerSession.sessionID);
      }
      return ids;
    },

    cancelAll() {
      for (const tracker of issueAgents.values()) {
        cancelSession(tracker, 'Shutdown');
      }
      if (plannerSession) {
        cancelSession(plannerSession, 'Shutdown');
      }
    },
  };

  function startSession(params: StartSessionParams): AgentSessionTracker {
    const abortController = new AbortController();

    const queryHandle = queryFactory({
      prompt: params.prompt,
      cwd: params.cwd,
      systemPrompt: params.systemPrompt,
      abortController,
      permissionMode: 'bypassPermissions',
    });

    const tracker: AgentSessionTracker = {
      agentType: params.agentType,
      sessionID: '', // populated from init message
      query: queryHandle,
      abortController,
      timer: setTimeout(() => {
        cancelSession(tracker, `Agent exceeded max duration of ${maxAgentDuration}s`);
      }, maxAgentDuration * 1000),
      outputChunks: [],
      outputListeners: new Set(),
      done: false,
      ...(params.worktreePath !== undefined && { worktreePath: params.worktreePath }),
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
        processMessage(tracker, message);
      }

      // If we reach here without a result message, treat as success
      sessionSucceeded = !errorMessage;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    // Check if we already got a result message that set the outcome
    if (tracker.done) return;

    finishSession(tracker, sessionSucceeded, errorMessage, onCleanup);
  }

  function processMessage(tracker: AgentSessionTracker, message: SDKMessage): void {
    match(message)
      .with({ type: 'system', subtype: 'init' }, (msg) => {
        tracker.sessionID = msg.session_id;
        emitter.emit(buildStartedEvent(tracker));
      })
      .with({ type: 'assistant' }, (msg) => {
        const text = extractTextFromAssistantMessage(msg.message);
        if (text) {
          tracker.outputChunks.push(text);
          for (const listener of tracker.outputListeners) {
            listener(text);
          }
        }
      })
      .with({ type: 'result', subtype: 'success' }, () => {
        finishSession(tracker, true, undefined, () => {
          removeFromTracking(tracker);
        });
      })
      .with(
        { type: 'result', subtype: P.union('error_max_turns', 'error_during_execution') },
        () => {
          finishSession(tracker, false, 'Agent session ended with error', () => {
            removeFromTracking(tracker);
          });
        },
      )
      .otherwise(() => {
        // Ignore other message types (user replays, stream events, compact boundaries)
      });
  }

  function finishSession(
    tracker: AgentSessionTracker,
    succeeded: boolean,
    errorMessage: string | undefined,
    onCleanup: () => void,
  ): void {
    if (tracker.done) return;
    tracker.done = true;

    clearTimeout(tracker.timer);
    onCleanup();

    // Notify stream listeners that the stream is done
    for (const listener of tracker.outputListeners) {
      listener('');
    }
    tracker.outputListeners.clear();

    if (succeeded) {
      emitter.emit(buildCompletedEvent(tracker));

      if (tracker.agentType === 'implementor' && tracker.issueNumber !== undefined) {
        worktreeManager.remove(tracker.issueNumber).catch(() => {
          // Worktree cleanup failure is non-fatal
        });
      }
      return;
    }

    emitter.emit(buildFailedEvent(tracker, errorMessage ?? 'Unknown error'));
    // Implementor worktrees are preserved on failure (no cleanup)
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

  function cancelSession(tracker: AgentSessionTracker, reason: string): void {
    if (tracker.done) return;

    tracker.abortController.abort();
    tracker.query.interrupt().catch(() => {
      // Interrupt may fail if the session is already done
    });

    finishSession(tracker, false, reason, () => {
      removeFromTracking(tracker);
    });
  }
}

type StartSessionParams = {
  agentType: AgentType;
  prompt: string;
  cwd: string;
  systemPrompt: string;
  issueNumber?: number;
  specPaths?: string[];
  worktreePath?: string;
};

function buildAsyncIterable(tracker: AgentSessionTracker): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      let chunkIndex = 0;

      return {
        next() {
          // Yield any buffered chunks first
          if (chunkIndex < tracker.outputChunks.length) {
            const value = tracker.outputChunks[chunkIndex]!;
            chunkIndex++;
            return Promise.resolve({ value, done: false });
          }

          // If the session is done, we're done
          if (tracker.done) {
            return Promise.resolve({ value: undefined, done: true as const });
          }

          // Wait for the next chunk
          return new Promise<IteratorResult<string>>((resolve) => {
            const listener: OutputListener = (chunk) => {
              tracker.outputListeners.delete(listener);
              if (chunk === '' || tracker.done) {
                resolve({ value: undefined, done: true as const });
                return;
              }
              chunkIndex++;
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

  if (typeof content === 'string') return content;

  if (!Array.isArray(content)) return '';

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') {
      const textBlock = block as { text: string };
      textParts.push(textBlock.text);
    }
  }

  return textParts.join('');
}

function buildStartedEvent(tracker: AgentSessionTracker): AgentStartedEvent {
  return {
    type: 'agentStarted',
    agentType: tracker.agentType,
    sessionID: tracker.sessionID,
    ...(tracker.issueNumber !== undefined && { issueNumber: tracker.issueNumber }),
    ...(tracker.specPaths && { specPaths: tracker.specPaths }),
  };
}

function buildCompletedEvent(tracker: AgentSessionTracker): AgentCompletedEvent {
  return {
    type: 'agentCompleted',
    agentType: tracker.agentType,
    sessionID: tracker.sessionID,
    ...(tracker.issueNumber !== undefined && { issueNumber: tracker.issueNumber }),
    ...(tracker.specPaths && { specPaths: tracker.specPaths }),
  };
}

function buildFailedEvent(tracker: AgentSessionTracker, error: string): AgentFailedEvent {
  return {
    type: 'agentFailed',
    agentType: tracker.agentType,
    sessionID: tracker.sessionID,
    error,
    ...(tracker.issueNumber !== undefined && { issueNumber: tracker.issueNumber }),
    ...(tracker.specPaths && { specPaths: tracker.specPaths }),
    ...(tracker.agentType === 'implementor' &&
      tracker.worktreePath && { worktreePath: tracker.worktreePath }),
  };
}

function buildSkippedEvent(
  agentType: AgentType,
  context: { issueNumber?: number; specPaths?: string[] },
): AgentSkippedEvent {
  return {
    type: 'agentSkipped',
    agentType,
    ...(context.issueNumber !== undefined && { issueNumber: context.issueNumber }),
    ...(context.specPaths && { specPaths: context.specPaths }),
  };
}
