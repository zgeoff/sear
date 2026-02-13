import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type {
  CachedIssueDetail,
  CachedPRDetail,
  Task,
  TaskAgent,
  TaskStatus,
  TUIStore,
} from '../types.ts';

export interface DetailPaneProps {
  store: StoreApi<TUIStore>;
  paneWidth: number;
  paneHeight: number;
}

type ContentView =
  | { view: 'none' }
  | { view: 'issueDetail'; task: Task; detail: CachedIssueDetail | null }
  | { view: 'agentStream'; task: Task; lines: string[] }
  | { view: 'prSummary'; task: Task; prDetails: PrSummaryEntry[] }
  | { view: 'crashDetail'; task: Task; agent: TaskAgent | null };

interface PrSummaryEntry {
  prNumber: number;
  detail: CachedPRDetail | null;
  ciStatus: 'pending' | 'success' | 'failure' | null;
}

const SCROLL_STEP = 1;
const ELLIPSIS = '\u2026';
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape sequences use control characters by definition
const ANSI_REGEX = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

export function DetailPane(props: DetailPaneProps): ReactNode {
  const pinnedTask = useStore(props.store, (s) => s.pinnedTask);
  const tasks = useStore(props.store, (s) => s.tasks);
  const agentStreams = useStore(props.store, (s) => s.agentStreams);
  const issueDetailCache = useStore(props.store, (s) => s.issueDetailCache);
  const prDetailCache = useStore(props.store, (s) => s.prDetailCache);
  const focusedPane = useStore(props.store, (s) => s.focusedPane);

  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevChunkCountRef = useRef(0);

  const visibleRowCount = props.paneHeight;

  const task = pinnedTask !== null ? (tasks.get(pinnedTask) ?? null) : null;
  const contentView = resolveContentView({
    task,
    agentStreams,
    issueDetailCache,
    prDetailCache,
  });

  const allLines = buildContentLines(contentView);
  const lineCount = allLines.length;

  const isStreaming = contentView.view === 'agentStream';
  const streamLines = isStreaming ? contentView.lines : undefined;
  const chunkCount = streamLines?.length ?? 0;

  const prevPinnedTaskRef = useRef(pinnedTask);
  const prevStatusRef = useRef<TaskStatus | null>(task?.status ?? null);

  useEffect(() => {
    const pinnedChanged = pinnedTask !== prevPinnedTaskRef.current;
    const currentStatus = task?.status ?? null;
    const statusChanged = currentStatus !== prevStatusRef.current;

    prevPinnedTaskRef.current = pinnedTask;
    prevStatusRef.current = currentStatus;

    if (pinnedChanged || statusChanged) {
      setAutoScroll(true);
      prevChunkCountRef.current = 0;

      if (isStreaming) {
        setScrollOffset(Math.max(0, lineCount - visibleRowCount));
      } else {
        setScrollOffset(0);
      }
      return;
    }

    if (isStreaming && chunkCount > prevChunkCountRef.current && autoScroll) {
      setScrollOffset(Math.max(0, lineCount - visibleRowCount));
    }
    prevChunkCountRef.current = chunkCount;
  }, [pinnedTask, task?.status, chunkCount, autoScroll, isStreaming, lineCount, visibleRowCount]);

  useInput((input, key) => {
    if (focusedPane !== 'detailPane') {
      return;
    }

    const isUp = key.upArrow || input === 'k';
    const isDown = key.downArrow || input === 'j';

    if (isUp) {
      setScrollOffset((prev) => Math.max(0, prev - SCROLL_STEP));
      if (isStreaming) {
        setAutoScroll(false);
      }
    }
    if (isDown) {
      setScrollOffset((prev) => {
        const maxOffset = Math.max(0, lineCount - visibleRowCount);
        const next = Math.min(prev + SCROLL_STEP, maxOffset);
        if (isStreaming && next >= lineCount - visibleRowCount) {
          setAutoScroll(true);
        }
        return next;
      });
    }
  });

  const clampedOffset = Math.max(
    0,
    Math.min(scrollOffset, Math.max(0, lineCount - visibleRowCount)),
  );
  const windowedLines = allLines.slice(clampedOffset, clampedOffset + visibleRowCount);

  return (
    <Box flexDirection="column">
      {windowedLines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: content lines have no stable identity
        <Text key={clampedOffset + i}>{truncateLine(line, props.paneWidth)}</Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Content View Resolution
// ---------------------------------------------------------------------------

interface ResolveContentViewParams {
  task: Task | null;
  agentStreams: Map<string, string[]>;
  issueDetailCache: Map<number, CachedIssueDetail>;
  prDetailCache: Map<number, CachedPRDetail>;
}

function resolveContentView(params: ResolveContentViewParams): ContentView {
  if (params.task === null) {
    return { view: 'none' };
  }

  const task = params.task;

  return match(task.status)
    .with('ready-to-implement', 'needs-refinement', 'blocked', (): ContentView => {
      const detail = params.issueDetailCache.get(task.issueNumber) ?? null;
      return { view: 'issueDetail', task, detail };
    })
    .with('agent-implementing', 'agent-reviewing', (): ContentView => {
      const sessionID = task.agent?.sessionID;
      const lines = sessionID ? (params.agentStreams.get(sessionID) ?? []) : [];
      return { view: 'agentStream', task, lines };
    })
    .with('ready-to-merge', (): ContentView => {
      const prDetails: PrSummaryEntry[] = task.prs.map((pr) => ({
        prNumber: pr.number,
        detail: params.prDetailCache.get(pr.number) ?? null,
        ciStatus: pr.ciStatus,
      }));
      return { view: 'prSummary', task, prDetails };
    })
    .with('agent-crashed', (): ContentView => ({ view: 'crashDetail', task, agent: task.agent }))
    .exhaustive();
}

// ---------------------------------------------------------------------------
// Content Line Builders
// ---------------------------------------------------------------------------

function buildContentLines(contentView: ContentView): string[] {
  return match(contentView)
    .with({ view: 'none' }, () => buildNoTaskLines())
    .with({ view: 'issueDetail' }, (cv) => buildIssueDetailLines(cv.task, cv.detail))
    .with({ view: 'agentStream' }, (cv) => buildAgentStreamLines(cv.task, cv.lines))
    .with({ view: 'prSummary' }, (cv) => buildPrSummaryLines(cv.task, cv.prDetails))
    .with({ view: 'crashDetail' }, (cv) => buildCrashDetailLines(cv.agent))
    .exhaustive();
}

function buildNoTaskLines(): string[] {
  return ['No task selected'];
}

function buildIssueDetailLines(task: Task, detail: CachedIssueDetail | null): string[] {
  const lines: string[] = [`#${task.issueNumber} ${task.title}`];

  if (detail === null) {
    lines.push('Loading...');
    return lines;
  }

  lines.push(`Labels: ${detail.labels.join(', ')}`);
  if (detail.stale) {
    lines.push('(Refreshing...)');
  }
  lines.push('');
  lines.push(...detail.body.split('\n'));
  return lines;
}

function buildAgentStreamLines(task: Task, lines: string[]): string[] {
  const agentLabel = task.agent?.type === 'implementor' ? 'Implementor' : 'Reviewer';
  return [`${agentLabel} output for #${task.issueNumber}`, ...lines];
}

function buildPrSummaryLines(task: Task, prDetails: PrSummaryEntry[]): string[] {
  if (prDetails.length === 0) {
    return [`#${task.issueNumber} ${task.title}`, 'No linked PRs'];
  }

  const lines: string[] = [];

  for (const entry of prDetails) {
    if (entry.detail === null) {
      lines.push(`PR #${entry.prNumber}: Loading...`);
    } else {
      lines.push(`PR #${entry.prNumber}: ${entry.detail.title}`);
      lines.push(`Changed files: ${entry.detail.changedFilesCount}`);
      lines.push(`CI: ${entry.ciStatus ?? 'unknown'}`);

      if (entry.ciStatus === 'failure' && entry.detail.failedCheckNames) {
        for (const checkName of entry.detail.failedCheckNames) {
          lines.push(`  - ${checkName}`);
        }
      }

      if (entry.detail.stale) {
        lines.push('(Refreshing...)');
      }
    }
  }

  return lines;
}

function buildCrashDetailLines(agent: TaskAgent | null): string[] {
  if (agent === null) {
    return ['Crash information unavailable', 'Press [d] to retry'];
  }

  const agentLabel = agent.type === 'implementor' ? 'Implementor' : 'Reviewer';
  const lines: string[] = [`Agent: ${agentLabel}`];

  if (agent.crash) {
    lines.push(`\x1b[31mError: ${agent.crash.error}\x1b[0m`);
  }

  lines.push(`Session: ${agent.sessionID}`);

  if (agent.branchName) {
    lines.push(`Branch: ${agent.branchName}`);
  }

  if (agent.logFilePath) {
    lines.push(`Log: ${buildOSC8Link(`file://${agent.logFilePath}`, agent.logFilePath)}`);
  }

  lines.push('Press [d] to retry');
  return lines;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  const visualWidth = stripAnsi(line).length;
  if (visualWidth <= maxWidth) {
    return line;
  }
  if (maxWidth === 1) {
    return ELLIPSIS;
  }
  return stripAndTruncate(line, maxWidth - 1) + ELLIPSIS;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function stripAndTruncate(text: string, maxVisibleChars: number): string {
  let visibleCount = 0;
  let i = 0;
  while (i < text.length && visibleCount < maxVisibleChars) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i);
      if (end !== -1) {
        i = end + 1;
      } else {
        visibleCount += 1;
        i += 1;
      }
    } else if (text[i] === '\x1b' && text[i + 1] === ']') {
      const end = text.indexOf('\x07', i);
      if (end !== -1) {
        i = end + 1;
      } else {
        visibleCount += 1;
        i += 1;
      }
    } else {
      visibleCount += 1;
      i += 1;
    }
  }
  return text.slice(0, i);
}

function buildOSC8Link(url: string, displayText: string): string {
  return `\x1b]8;;${url}\x07${displayText}\x1b]8;;\x07`;
}
