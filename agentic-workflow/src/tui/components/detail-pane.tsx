import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { match, P } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type {
  CachedIssueDetails,
  CachedPRDetails,
  EngineStore,
  LastFailure,
  TrackedIssue,
} from '../types.ts';

export interface DetailPaneProps {
  store: StoreApi<EngineStore>;
  paneWidth: number;
  paneHeight: number;
}

type IssueState =
  | { view: 'none' }
  | { view: 'loading'; issue: TrackedIssue }
  | { view: 'failure'; issue: TrackedIssue; failure: LastFailure }
  | { view: 'streaming'; issue: TrackedIssue; chunks: string[] }
  | { view: 'issueDetails'; issue: TrackedIssue; details: CachedIssueDetails }
  | { view: 'issueDetailsWithGuidance'; issue: TrackedIssue; details: CachedIssueDetails }
  | { view: 'prSummary'; issue: TrackedIssue; pr: CachedPRDetails }
  | { view: 'prApproved'; issue: TrackedIssue; pr: CachedPRDetails }
  | { view: 'noPR'; issue: TrackedIssue };

interface ResolveIssueStateParams {
  issue: TrackedIssue | null;
  selectedIssue: number | null;
  agentStreams: Map<number, string[]>;
  issueDetails: Map<number, CachedIssueDetails>;
  prDetails: Map<number, CachedPRDetails>;
  prNotFound: Set<number>;
}

const SCROLL_STEP = 1;
const ELLIPSIS = '\u2026';
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI/OSC escape sequences use control characters by definition
const ANSI_REGEX = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

export function DetailPane(props: DetailPaneProps): ReactNode {
  const selectedIssue = useStore(props.store, (s) => s.selectedIssue);
  const issues = useStore(props.store, (s) => s.issues);
  const agentStreams = useStore(props.store, (s) => s.agentStreams);
  const issueDetails = useStore(props.store, (s) => s.issueDetails);
  const prDetails = useStore(props.store, (s) => s.prDetails);
  const focusedPane = useStore(props.store, (s) => s.focusedPane);

  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevChunkCountRef = useRef(0);

  const visibleRowCount = props.paneHeight;

  const prNotFound = useStore(props.store, (s) => s.prNotFound);

  const issue = selectedIssue !== null ? (issues.get(selectedIssue) ?? null) : null;
  const issueState = resolveIssueState({
    issue,
    selectedIssue,
    agentStreams,
    issueDetails,
    prDetails,
    prNotFound,
  });

  const allLines = buildContentLines(issueState);
  const lineCount = allLines.length;

  const isStreaming = issueState.view === 'streaming';
  const chunks = isStreaming ? issueState.chunks : undefined;
  const chunkCount = chunks?.length ?? 0;

  const prevSelectedIssueRef = useRef(selectedIssue);

  useEffect(() => {
    const issueChanged = selectedIssue !== prevSelectedIssueRef.current;
    prevSelectedIssueRef.current = selectedIssue;

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
  }, [selectedIssue, chunkCount, autoScroll, isStreaming, lineCount, visibleRowCount]);

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
    .with({ view: 'failure' }, (s) => buildFailureLines(s.issue, s.failure))
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
  return ['No issue selected'];
}

function buildLoadingLines(issue: TrackedIssue): string[] {
  return [`#${issue.number} ${issue.title}`, 'Loading...'];
}

function buildNoPRFoundLines(): string[] {
  return ['No PR found'];
}

function buildFailureLines(issue: TrackedIssue, failure: LastFailure): string[] {
  const agentLabel = failure.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
  const lines: string[] = [
    'Agent Failure',
    `Issue: #${issue.number} ${issue.title}`,
    `Agent: ${agentLabel}`,
    `Error: ${failure.error}`,
    `Session: ${failure.sessionID}`,
  ];
  if (failure.worktreePath) {
    lines.push(`Worktree: ${failure.worktreePath}`);
  }
  if (failure.logFilePath) {
    lines.push(`Log: ${buildOSC8Link(`file://${failure.logFilePath}`, failure.logFilePath)}`);
  }
  lines.push('Press Enter in the issue list to retry.');
  return lines;
}

function buildStreamingLines(issue: TrackedIssue, chunks: string[]): string[] {
  const agentLabel = issue.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
  return [`${agentLabel} output for #${issue.number}`, ...chunks];
}

function buildIssueDetailsLines(issue: TrackedIssue, details: CachedIssueDetails): string[] {
  const lines: string[] = [
    `#${issue.number} ${issue.title}`,
    `Labels: ${details.labels.join(', ')}`,
  ];
  if (details.stale) {
    lines.push('(Refreshing...)');
  }
  lines.push('');
  lines.push(...details.body.split('\n'));
  return lines;
}

function buildIssueDetailsWithGuidanceLines(
  issue: TrackedIssue,
  details: CachedIssueDetails,
): string[] {
  const statusDisplay = issue.statusLabel === 'needs-refinement' ? 'Needs Refinement' : 'Blocked';
  const lines: string[] = [
    `#${issue.number} ${issue.title}`,
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

function buildPrSummaryLines(issue: TrackedIssue, pr: CachedPRDetails): string[] {
  const lines: string[] = [
    `PR #${pr.number}: ${pr.title}`,
    `Issue: #${issue.number} ${issue.title}`,
    `Changed files: ${pr.changedFilesCount}`,
    `CI: ${pr.ciStatus}`,
  ];
  if (pr.stale) {
    lines.push('(Refreshing...)');
  }
  return lines;
}

function buildPrApprovedLines(issue: TrackedIssue, pr: CachedPRDetails): string[] {
  const lines: string[] = [
    'Ready to Merge',
    `PR #${pr.number}: ${pr.title}`,
    `Issue: #${issue.number} ${issue.title}`,
    `Changed files: ${pr.changedFilesCount}`,
    `CI: ${pr.ciStatus}`,
  ];
  if (pr.stale) {
    lines.push('(Refreshing...)');
  }
  return lines;
}

function resolveIssueState(params: ResolveIssueStateParams): IssueState {
  const { issue, selectedIssue, agentStreams, issueDetails, prDetails, prNotFound } = params;
  if (selectedIssue === null || !issue) {
    return { view: 'none' };
  }

  if (issue.lastFailure) {
    return { view: 'failure', issue, failure: issue.lastFailure };
  }

  if (issue.agentRunning) {
    const chunks = agentStreams.get(issue.number) ?? [];
    return { view: 'streaming', issue, chunks };
  }

  return match(issue.statusLabel)
    .with(P.union('pending', 'unblocked', 'needs-changes'), (): IssueState => {
      const details = issueDetails.get(issue.number);
      if (!details) {
        return { view: 'loading', issue };
      }
      return { view: 'issueDetails', issue, details };
    })
    .with('review', (): IssueState => {
      const pr = prDetails.get(issue.number);
      if (pr) {
        return { view: 'prSummary', issue, pr };
      }
      if (prNotFound.has(issue.number)) {
        return { view: 'noPR', issue };
      }
      return { view: 'loading', issue };
    })
    .with(P.union('needs-refinement', 'blocked'), (): IssueState => {
      const details = issueDetails.get(issue.number);
      if (!details) {
        return { view: 'loading', issue };
      }
      return { view: 'issueDetailsWithGuidance', issue, details };
    })
    .with('approved', (): IssueState => {
      const pr = prDetails.get(issue.number);
      if (pr) {
        return { view: 'prApproved', issue, pr };
      }
      if (prNotFound.has(issue.number)) {
        return { view: 'noPR', issue };
      }
      return { view: 'loading', issue };
    })
    .otherwise((): IssueState => {
      const details = issueDetails.get(issue.number);
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
