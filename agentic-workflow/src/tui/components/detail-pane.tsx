import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { match, P } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type { AgentCrash, CachedIssueDetail, CachedPRDetail, Task, TUIStore } from '../types.ts';

export interface DetailPaneProps {
  store: StoreApi<TUIStore>;
  paneWidth: number;
  paneHeight: number;
}

type IssueState =
  | { view: 'none' }
  | { view: 'loading'; issue: Task }
  | { view: 'failure'; issue: Task; crash: AgentCrash }
  | { view: 'streaming'; issue: Task; chunks: string[] }
  | { view: 'issueDetails'; issue: Task; details: CachedIssueDetail }
  | { view: 'issueDetailsWithGuidance'; issue: Task; details: CachedIssueDetail }
  | { view: 'prSummary'; issue: Task; pr: CachedPRDetail }
  | { view: 'prApproved'; issue: Task; pr: CachedPRDetail }
  | { view: 'noPR'; issue: Task };

interface ResolveIssueStateParams {
  issue: Task | null;
  pinnedTask: number | null;
  agentStreams: Map<string, string[]>;
  issueDetailCache: Map<number, CachedIssueDetail>;
  prDetailCache: Map<number, CachedPRDetail>;
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

  const issue = pinnedTask !== null ? (tasks.get(pinnedTask) ?? null) : null;
  const issueState = resolveIssueState({
    issue,
    pinnedTask,
    agentStreams,
    issueDetailCache,
    prDetailCache,
  });

  const allLines = buildContentLines(issueState);
  const lineCount = allLines.length;

  const isStreaming = issueState.view === 'streaming';
  const chunks = isStreaming ? issueState.chunks : undefined;
  const chunkCount = chunks?.length ?? 0;

  const prevPinnedTaskRef = useRef(pinnedTask);

  useEffect(() => {
    const issueChanged = pinnedTask !== prevPinnedTaskRef.current;
    prevPinnedTaskRef.current = pinnedTask;

    if (issueChanged) {
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
  }, [pinnedTask, chunkCount, autoScroll, isStreaming, lineCount, visibleRowCount]);

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

function buildContentLines(issueState: IssueState): string[] {
  return match(issueState)
    .with({ view: 'none' }, () => buildNoSelectionLines())
    .with({ view: 'loading' }, (s) => buildLoadingLines(s.issue))
    .with({ view: 'failure' }, (s) => buildFailureLines(s.issue, s.crash))
    .with({ view: 'streaming' }, (s) => buildStreamingLines(s.issue, s.chunks))
    .with({ view: 'issueDetails' }, (s) => buildIssueDetailsLines(s.issue, s.details))
    .with({ view: 'issueDetailsWithGuidance' }, (s) =>
      buildIssueDetailsWithGuidanceLines(s.issue, s.details),
    )
    .with({ view: 'prSummary' }, (s) => buildPrSummaryLines(s.issue, s.pr))
    .with({ view: 'prApproved' }, (s) => buildPrApprovedLines(s.issue, s.pr))
    .with({ view: 'noPR' }, () => buildNoPRFoundLines())
    .exhaustive();
}

function buildNoSelectionLines(): string[] {
  return ['No task selected'];
}

function buildLoadingLines(issue: Task): string[] {
  return [`#${issue.issueNumber} ${issue.title}`, 'Loading...'];
}

function buildNoPRFoundLines(): string[] {
  return ['No PR found'];
}

function buildFailureLines(issue: Task, crash: AgentCrash): string[] {
  const agent = issue.agent;
  const agentLabel = agent?.type === 'implementor' ? 'Implementor' : 'Reviewer';
  const lines: string[] = [
    'Agent Failure',
    `Issue: #${issue.issueNumber} ${issue.title}`,
    `Agent: ${agentLabel}`,
    `Error: ${crash.error}`,
  ];
  if (agent?.sessionID) {
    lines.push(`Session: ${agent.sessionID}`);
  }
  if (agent?.branchName) {
    lines.push(`Branch: ${agent.branchName}`);
  }
  if (agent?.logFilePath) {
    lines.push(`Log: ${buildOSC8Link(`file://${agent.logFilePath}`, agent.logFilePath)}`);
  }
  lines.push('Press Enter in the issue list to retry.');
  return lines;
}

function buildStreamingLines(issue: Task, chunks: string[]): string[] {
  const agentLabel = issue.agent?.type === 'implementor' ? 'Implementor' : 'Reviewer';
  return [`${agentLabel} output for #${issue.issueNumber}`, ...chunks];
}

function buildIssueDetailsLines(issue: Task, details: CachedIssueDetail): string[] {
  const lines: string[] = [
    `#${issue.issueNumber} ${issue.title}`,
    `Labels: ${details.labels.join(', ')}`,
  ];
  if (details.stale) {
    lines.push('(Refreshing...)');
  }
  lines.push('');
  lines.push(...details.body.split('\n'));
  return lines;
}

function buildIssueDetailsWithGuidanceLines(issue: Task, details: CachedIssueDetail): string[] {
  const statusDisplay = issue.statusLabel === 'needs-refinement' ? 'Needs Refinement' : 'Blocked';
  const lines: string[] = [
    `#${issue.issueNumber} ${issue.title}`,
    statusDisplay,
    `Labels: ${details.labels.join(', ')}`,
  ];
  if (details.stale) {
    lines.push('(Refreshing...)');
  }
  lines.push('');
  lines.push(...details.body.split('\n'));
  return lines;
}

function buildPrSummaryLines(issue: Task, pr: CachedPRDetail): string[] {
  const taskPR = issue.prs.find((p) => p.number !== undefined);
  const prNumber = taskPR?.number ?? 0;
  const ciStatus = taskPR?.ciStatus ?? null;
  const lines: string[] = [
    `PR #${prNumber}: ${pr.title}`,
    `Issue: #${issue.issueNumber} ${issue.title}`,
    `Changed files: ${pr.changedFilesCount}`,
    `CI: ${ciStatus ?? 'unknown'}`,
  ];
  if (ciStatus === 'failure' && pr.failedCheckNames) {
    lines.push('CI: FAILURE');
    for (const checkName of pr.failedCheckNames) {
      lines.push(`  - ${checkName}`);
    }
  }
  if (pr.stale) {
    lines.push('(Refreshing...)');
  }
  return lines;
}

function buildPrApprovedLines(issue: Task, pr: CachedPRDetail): string[] {
  const taskPR = issue.prs.find((p) => p.number !== undefined);
  const prNumber = taskPR?.number ?? 0;
  const ciStatus = taskPR?.ciStatus ?? null;
  const lines: string[] = [
    'Ready to Merge',
    `PR #${prNumber}: ${pr.title}`,
    `Issue: #${issue.issueNumber} ${issue.title}`,
    `Changed files: ${pr.changedFilesCount}`,
    `CI: ${ciStatus ?? 'unknown'}`,
  ];
  if (ciStatus === 'failure' && pr.failedCheckNames) {
    lines.push('CI: FAILURE');
    for (const checkName of pr.failedCheckNames) {
      lines.push(`  - ${checkName}`);
    }
  }
  if (pr.stale) {
    lines.push('(Refreshing...)');
  }
  return lines;
}

function resolveIssueState(params: ResolveIssueStateParams): IssueState {
  const { issue, pinnedTask, agentStreams, issueDetailCache, prDetailCache } = params;
  if (pinnedTask === null || !issue) {
    return { view: 'none' };
  }

  if (issue.agent?.crash) {
    return { view: 'failure', issue, crash: issue.agent.crash };
  }

  if (issue.agent?.running) {
    const chunks = agentStreams.get(issue.agent.sessionID) ?? [];
    return { view: 'streaming', issue, chunks };
  }

  const firstPR = issue.prs[0];

  return match(issue.statusLabel)
    .with(P.union('pending', 'unblocked', 'needs-changes'), (): IssueState => {
      const details = issueDetailCache.get(issue.issueNumber);
      if (!details) {
        return { view: 'loading', issue };
      }
      return { view: 'issueDetails', issue, details };
    })
    .with('review', (): IssueState => {
      if (firstPR) {
        const pr = prDetailCache.get(firstPR.number);
        if (pr) {
          return { view: 'prSummary', issue, pr };
        }
      }
      if (issue.prs.length === 0) {
        return { view: 'noPR', issue };
      }
      return { view: 'loading', issue };
    })
    .with(P.union('needs-refinement', 'blocked'), (): IssueState => {
      const details = issueDetailCache.get(issue.issueNumber);
      if (!details) {
        return { view: 'loading', issue };
      }
      return { view: 'issueDetailsWithGuidance', issue, details };
    })
    .with('approved', (): IssueState => {
      if (firstPR) {
        const pr = prDetailCache.get(firstPR.number);
        if (pr) {
          return { view: 'prApproved', issue, pr };
        }
      }
      if (issue.prs.length === 0) {
        return { view: 'noPR', issue };
      }
      return { view: 'loading', issue };
    })
    .otherwise((): IssueState => {
      const details = issueDetailCache.get(issue.issueNumber);
      if (!details) {
        return { view: 'loading', issue };
      }
      return { view: 'issueDetails', issue, details };
    });
}

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
