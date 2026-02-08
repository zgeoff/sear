import { Box, Text, useInput } from 'ink';
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
} from '../types';

export type DetailPaneProps = {
  store: StoreApi<EngineStore>;
};

type IssueState =
  | { view: 'none' }
  | { view: 'loading'; issue: TrackedIssue }
  | { view: 'failure'; issue: TrackedIssue; failure: LastFailure }
  | { view: 'streaming'; issue: TrackedIssue; chunks: string[] }
  | { view: 'issueDetails'; issue: TrackedIssue; details: CachedIssueDetails }
  | { view: 'issueDetailsWithGuidance'; issue: TrackedIssue; details: CachedIssueDetails }
  | { view: 'prSummary'; issue: TrackedIssue; pr: CachedPRDetails }
  | { view: 'prApproved'; issue: TrackedIssue; pr: CachedPRDetails };

type LoadingViewProps = {
  issue: TrackedIssue;
};

type FailureViewProps = {
  issue: TrackedIssue;
  failure: LastFailure;
};

type StreamingViewProps = {
  issue: TrackedIssue;
  chunks: string[];
  scrollOffset: number;
};

type IssueDetailsViewProps = {
  issue: TrackedIssue;
  details: CachedIssueDetails;
  scrollOffset: number;
};

type PRViewProps = {
  issue: TrackedIssue;
  pr: CachedPRDetails;
};

const SCROLL_STEP = 1;

export function DetailPane({ store }: DetailPaneProps) {
  const selectedIssue = useStore(store, (s) => s.selectedIssue);
  const issues = useStore(store, (s) => s.issues);
  const agentStreams = useStore(store, (s) => s.agentStreams);
  const issueDetails = useStore(store, (s) => s.issueDetails);
  const prDetails = useStore(store, (s) => s.prDetails);
  const focusedPane = useStore(store, (s) => s.focusedPane);

  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevChunkCountRef = useRef(0);

  const issue = selectedIssue !== null ? (issues.get(selectedIssue) ?? null) : null;
  const issueState = resolveIssueState(issue, selectedIssue, agentStreams, issueDetails, prDetails);

  const chunks = issueState.view === 'streaming' ? issueState.chunks : undefined;
  const chunkCount = chunks?.length ?? 0;

  useEffect(() => {
    if (chunks && chunkCount > prevChunkCountRef.current && autoScroll) {
      setScrollOffset(Math.max(0, chunkCount - 1));
    }
    prevChunkCountRef.current = chunkCount;
  }, [chunkCount, autoScroll, chunks]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset scroll state when selected issue changes
  useEffect(() => {
    setScrollOffset(0);
    setAutoScroll(true);
    prevChunkCountRef.current = 0;
  }, [selectedIssue]);

  useInput((input, key) => {
    if (focusedPane !== 'detailPane') return;

    const isUp = key.upArrow || input === 'k';
    const isDown = key.downArrow || input === 'j';

    if (isUp) {
      setScrollOffset((prev) => Math.max(0, prev - SCROLL_STEP));
      if (chunks) {
        setAutoScroll(false);
      }
    }
    if (isDown) {
      setScrollOffset((prev) => prev + SCROLL_STEP);
      if (chunks && scrollOffset + SCROLL_STEP >= chunkCount - 1) {
        setAutoScroll(true);
      }
    }
  });

  return match(issueState)
    .with({ view: 'none' }, () => <NoIssueSelected />)
    .with({ view: 'loading' }, ({ issue: i }) => <LoadingView issue={i} />)
    .with({ view: 'failure' }, ({ issue: i, failure }) => (
      <FailureView issue={i} failure={failure} />
    ))
    .with({ view: 'streaming' }, ({ issue: i, chunks: c }) => (
      <StreamingView issue={i} chunks={c} scrollOffset={scrollOffset} />
    ))
    .with({ view: 'issueDetails' }, ({ issue: i, details }) => (
      <IssueDetailsView issue={i} details={details} scrollOffset={scrollOffset} />
    ))
    .with({ view: 'issueDetailsWithGuidance' }, ({ issue: i, details }) => (
      <IssueDetailsWithGuidanceView issue={i} details={details} scrollOffset={scrollOffset} />
    ))
    .with({ view: 'prSummary' }, ({ issue: i, pr }) => <PRSummaryView issue={i} pr={pr} />)
    .with({ view: 'prApproved' }, ({ issue: i, pr }) => <PRApprovedView issue={i} pr={pr} />)
    .exhaustive();
}

function resolveIssueState(
  issue: TrackedIssue | null,
  selectedIssue: number | null,
  agentStreams: Map<number, string[]>,
  issueDetails: Map<number, CachedIssueDetails>,
  prDetails: Map<number, CachedPRDetails>,
): IssueState {
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
    .with(P.union('pending', 'unblocked', 'needs-changes'), () => {
      const details = issueDetails.get(issue.number);
      if (!details) {
        return { view: 'loading', issue } as IssueState;
      }
      return { view: 'issueDetails', issue, details } as IssueState;
    })
    .with('review', () => {
      const pr = prDetails.get(issue.number);
      if (!pr) {
        return { view: 'loading', issue } as IssueState;
      }
      return { view: 'prSummary', issue, pr } as IssueState;
    })
    .with(P.union('needs-refinement', 'blocked'), () => {
      const details = issueDetails.get(issue.number);
      if (!details) {
        return { view: 'loading', issue } as IssueState;
      }
      return { view: 'issueDetailsWithGuidance', issue, details } as IssueState;
    })
    .with('approved', () => {
      const pr = prDetails.get(issue.number);
      if (!pr) {
        return { view: 'loading', issue } as IssueState;
      }
      return { view: 'prApproved', issue, pr } as IssueState;
    })
    .otherwise(() => {
      const details = issueDetails.get(issue.number);
      if (!details) {
        return { view: 'loading', issue } as IssueState;
      }
      return { view: 'issueDetails', issue, details } as IssueState;
    });
}

function NoIssueSelected() {
  return <Text>No issue selected</Text>;
}

function LoadingView({ issue }: LoadingViewProps) {
  return (
    <Box flexDirection="column">
      <Text bold>
        #{issue.number} {issue.title}
      </Text>
      <Text dimColor>Loading...</Text>
    </Box>
  );
}

function FailureView({ issue, failure }: FailureViewProps) {
  const agentLabel = failure.agentType === 'implementor' ? 'Implementor' : 'Reviewer';

  return (
    <Box flexDirection="column">
      <Text bold color="red">
        Agent Failure
      </Text>
      <Text>
        Issue: #{issue.number} {issue.title}
      </Text>
      <Text>Agent: {agentLabel}</Text>
      <Text>Error: {failure.error}</Text>
      <Text>Session: {failure.sessionID}</Text>
      {failure.worktreePath && <Text>Worktree: {failure.worktreePath}</Text>}
      <Text dimColor>Press Enter in the issue list to retry.</Text>
    </Box>
  );
}

function StreamingView({ issue, chunks, scrollOffset }: StreamingViewProps) {
  const agentLabel = issue.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
  const visible = chunks.slice(scrollOffset);

  return (
    <Box flexDirection="column">
      <Text bold>
        {agentLabel} output for #{issue.number}
      </Text>
      {visible.map((chunk, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stream chunks have no stable identity
        <Text key={scrollOffset + i}>{chunk}</Text>
      ))}
    </Box>
  );
}

function IssueDetailsView({ issue, details, scrollOffset }: IssueDetailsViewProps) {
  const lines = details.body.split('\n');
  const visible = lines.slice(scrollOffset);

  return (
    <Box flexDirection="column">
      <Text bold>
        #{issue.number} {issue.title}
      </Text>
      <Text dimColor>Labels: {details.labels.join(', ')}</Text>
      {details.stale && <Text dimColor>(Refreshing...)</Text>}
      <Text> </Text>
      {visible.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: text lines have no stable identity
        <Text key={scrollOffset + i}>{line}</Text>
      ))}
    </Box>
  );
}

function IssueDetailsWithGuidanceView({ issue, details, scrollOffset }: IssueDetailsViewProps) {
  const statusDisplay = issue.statusLabel === 'needs-refinement' ? 'Needs Refinement' : 'Blocked';
  const lines = details.body.split('\n');
  const visible = lines.slice(scrollOffset);

  return (
    <Box flexDirection="column">
      <Text bold>
        #{issue.number} {issue.title}
      </Text>
      <Text bold color="yellow">
        {statusDisplay}
      </Text>
      <Text dimColor>Labels: {details.labels.join(', ')}</Text>
      {details.stale && <Text dimColor>(Refreshing...)</Text>}
      <Text> </Text>
      {visible.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: text lines have no stable identity
        <Text key={scrollOffset + i}>{line}</Text>
      ))}
    </Box>
  );
}

function PRSummaryView({ issue, pr }: PRViewProps) {
  return (
    <Box flexDirection="column">
      <Text bold>
        PR #{pr.number}: {pr.title}
      </Text>
      <Text>
        Issue: #{issue.number} {issue.title}
      </Text>
      <Text>Changed files: {pr.changedFilesCount}</Text>
      <Text>CI: {pr.ciStatus}</Text>
      {pr.stale && <Text dimColor>(Refreshing...)</Text>}
    </Box>
  );
}

function PRApprovedView({ issue, pr }: PRViewProps) {
  return (
    <Box flexDirection="column">
      <Text bold color="green">
        Ready to Merge
      </Text>
      <Text bold>
        PR #{pr.number}: {pr.title}
      </Text>
      <Text>
        Issue: #{issue.number} {issue.title}
      </Text>
      <Text>Changed files: {pr.changedFilesCount}</Text>
      <Text>CI: {pr.ciStatus}</Text>
      {pr.stale && <Text dimColor>(Refreshing...)</Text>}
    </Box>
  );
}
