import { Box, Text, useInput } from 'ink';
import Link from 'ink-link';
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
}

type IssueState =
  | { view: 'none' }
  | { view: 'loading'; issue: TrackedIssue }
  | { view: 'failure'; issue: TrackedIssue; failure: LastFailure }
  | { view: 'streaming'; issue: TrackedIssue; chunks: string[] }
  | { view: 'issueDetails'; issue: TrackedIssue; details: CachedIssueDetails }
  | { view: 'issueDetailsWithGuidance'; issue: TrackedIssue; details: CachedIssueDetails }
  | { view: 'prSummary'; issue: TrackedIssue; pr: CachedPRDetails }
  | { view: 'prApproved'; issue: TrackedIssue; pr: CachedPRDetails };

interface LoadingViewProps {
  issue: TrackedIssue;
}

interface FailureViewProps {
  issue: TrackedIssue;
  failure: LastFailure;
}

interface StreamingViewProps {
  issue: TrackedIssue;
  chunks: string[];
  scrollOffset: number;
}

interface IssueDetailsViewProps {
  issue: TrackedIssue;
  details: CachedIssueDetails;
  scrollOffset: number;
}

interface PrViewProps {
  issue: TrackedIssue;
  pr: CachedPRDetails;
}

const SCROLL_STEP = 1;

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

  const issue = selectedIssue !== null ? (issues.get(selectedIssue) ?? null) : null;
  const issueState = resolveIssueState({
    issue,
    selectedIssue,
    agentStreams,
    issueDetails,
    prDetails,
  });

  const chunks = issueState.view === 'streaming' ? issueState.chunks : undefined;
  const chunkCount = chunks?.length ?? 0;

  useEffect(() => {
    if (chunks && chunkCount > prevChunkCountRef.current && autoScroll) {
      setScrollOffset(Math.max(0, chunkCount - 1));
    }
    prevChunkCountRef.current = chunkCount;
  }, [chunkCount, autoScroll, chunks]);

  // selectedIssue is an intentional trigger — reset scroll state when the user
  // selects a different issue.  The effect body only calls stable setters and
  // mutates a ref, so Biome sees selectedIssue as unused, but removing it would
  // turn this into a mount-only effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIssue is a trigger, not a consumed value
  useEffect(() => {
    setScrollOffset(0);
    setAutoScroll(true);
    prevChunkCountRef.current = 0;
  }, [selectedIssue]);

  useInput((input, key) => {
    if (focusedPane !== 'detailPane') {
      return;
    }

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
    .with({ view: 'prSummary' }, ({ issue: i, pr }) => <PrSummaryView issue={i} pr={pr} />)
    .with({ view: 'prApproved' }, ({ issue: i, pr }) => <PrApprovedView issue={i} pr={pr} />)
    .exhaustive();
}

interface ResolveIssueStateParams {
  issue: TrackedIssue | null;
  selectedIssue: number | null;
  agentStreams: Map<number, string[]>;
  issueDetails: Map<number, CachedIssueDetails>;
  prDetails: Map<number, CachedPRDetails>;
}

function resolveIssueState(params: ResolveIssueStateParams): IssueState {
  const { issue, selectedIssue, agentStreams, issueDetails, prDetails } = params;
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
      if (!pr) {
        return { view: 'loading', issue };
      }
      return { view: 'prSummary', issue, pr };
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
      if (!pr) {
        return { view: 'loading', issue };
      }
      return { view: 'prApproved', issue, pr };
    })
    .otherwise((): IssueState => {
      const details = issueDetails.get(issue.number);
      if (!details) {
        return { view: 'loading', issue };
      }
      return { view: 'issueDetails', issue, details };
    });
}

function NoIssueSelected(): ReactNode {
  return <Text>No issue selected</Text>;
}

function LoadingView(props: LoadingViewProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold={true}>
        #{props.issue.number} {props.issue.title}
      </Text>
      <Text dimColor={true}>Loading...</Text>
    </Box>
  );
}

function FailureView(props: FailureViewProps): ReactNode {
  const agentLabel = props.failure.agentType === 'implementor' ? 'Implementor' : 'Reviewer';

  return (
    <Box flexDirection="column">
      <Text bold={true} color="red">
        Agent Failure
      </Text>
      <Text>
        Issue: #{props.issue.number} {props.issue.title}
      </Text>
      <Text>Agent: {agentLabel}</Text>
      <Text>Error: {props.failure.error}</Text>
      <Text>Session: {props.failure.sessionID}</Text>
      {props.failure.worktreePath ? <Text>Worktree: {props.failure.worktreePath}</Text> : null}
      {props.failure.logFilePath ? (
        <Text>
          Log:{' '}
          <Link url={`file://${props.failure.logFilePath}`} fallback={false}>
            {props.failure.logFilePath}
          </Link>
        </Text>
      ) : null}
      <Text dimColor={true}>Press Enter in the issue list to retry.</Text>
    </Box>
  );
}

function StreamingView(props: StreamingViewProps): ReactNode {
  const agentLabel = props.issue.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
  const visible = props.chunks.slice(props.scrollOffset);

  return (
    <Box flexDirection="column">
      <Text bold={true}>
        {agentLabel} output for #{props.issue.number}
      </Text>
      {visible.map((chunk, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stream chunks have no stable identity
        <Text key={props.scrollOffset + i}>{chunk}</Text>
      ))}
    </Box>
  );
}

function IssueDetailsView(props: IssueDetailsViewProps): ReactNode {
  const lines = props.details.body.split('\n');
  const visible = lines.slice(props.scrollOffset);

  return (
    <Box flexDirection="column">
      <Text bold={true}>
        #{props.issue.number} {props.issue.title}
      </Text>
      <Text dimColor={true}>Labels: {props.details.labels.join(', ')}</Text>
      {props.details.stale ? <Text dimColor={true}>(Refreshing...)</Text> : null}
      <Text> </Text>
      {visible.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: text lines have no stable identity
        <Text key={props.scrollOffset + i}>{line}</Text>
      ))}
    </Box>
  );
}

function IssueDetailsWithGuidanceView(props: IssueDetailsViewProps): ReactNode {
  const statusDisplay =
    props.issue.statusLabel === 'needs-refinement' ? 'Needs Refinement' : 'Blocked';
  const lines = props.details.body.split('\n');
  const visible = lines.slice(props.scrollOffset);

  return (
    <Box flexDirection="column">
      <Text bold={true}>
        #{props.issue.number} {props.issue.title}
      </Text>
      <Text bold={true} color="yellow">
        {statusDisplay}
      </Text>
      <Text dimColor={true}>Labels: {props.details.labels.join(', ')}</Text>
      {props.details.stale ? <Text dimColor={true}>(Refreshing...)</Text> : null}
      <Text> </Text>
      {visible.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: text lines have no stable identity
        <Text key={props.scrollOffset + i}>{line}</Text>
      ))}
    </Box>
  );
}

function PrSummaryView(props: PrViewProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold={true}>
        PR #{props.pr.number}: {props.pr.title}
      </Text>
      <Text>
        Issue: #{props.issue.number} {props.issue.title}
      </Text>
      <Text>Changed files: {props.pr.changedFilesCount}</Text>
      <Text>CI: {props.pr.ciStatus}</Text>
      {props.pr.stale ? <Text dimColor={true}>(Refreshing...)</Text> : null}
    </Box>
  );
}

function PrApprovedView(props: PrViewProps): ReactNode {
  return (
    <Box flexDirection="column">
      <Text bold={true} color="green">
        Ready to Merge
      </Text>
      <Text bold={true}>
        PR #{props.pr.number}: {props.pr.title}
      </Text>
      <Text>
        Issue: #{props.issue.number} {props.issue.title}
      </Text>
      <Text>Changed files: {props.pr.changedFilesCount}</Text>
      <Text>CI: {props.pr.ciStatus}</Text>
      {props.pr.stale ? <Text dimColor={true}>(Refreshing...)</Text> : null}
    </Box>
  );
}
