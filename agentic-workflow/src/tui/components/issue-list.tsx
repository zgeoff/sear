import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type { CachedPRDetails, EngineStore, TrackedIssue } from '../types.ts';
import { List } from './list/list.tsx';
import type { ListItemData } from './list/types.ts';

export type IssueListPromptChangeHandler = (message: string | null) => void;

export interface IssueListProps {
  store: StoreApi<EngineStore>;
  focused: boolean;
  onOpenURL: (url: string) => void;
  repository: string;
  paneWidth: number;
  paneHeight: number;
  viewportOffset: number;
  onViewportOffsetChange: (offset: number) => void;
  mouseScrolled: boolean;
  onMouseScrolledChange: (scrolled: boolean) => void;
  promptActive: boolean;
  onPromptChange: IssueListPromptChangeHandler;
}

type PromptState =
  | { type: 'none' }
  | { type: 'dispatch'; issueNumber: number }
  | { type: 'cancel'; issueNumber: number }
  | { type: 'retry'; issueNumber: number; agentType: 'implementor' | 'reviewer' };

const PRIORITY_ORDER: Record<string, number> = {
  'priority:high': 0,
  'priority:medium': 1,
  'priority:low': 2,
};

const SPINNER_FRAMES: readonly string[] = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
const SPINNER_INTERVAL_MS = 80;

const READY_MARKER = '\u25CF';
const STALE_MARKER = '\u25CB';
const REVIEW_MARKER = '\u25B6';
const BLOCKED_MARKER = '\u26A0';
const DONE_MARKER = '\u2713';
const ERROR_MARKER = '\u2717';

export function IssueList(props: IssueListProps): ReactNode {
  const issues = useStore(props.store, (s) => s.issues);
  const selectedIssue = useStore(props.store, (s) => s.selectedIssue);
  const selectIssue = useStore(props.store, (s) => s.selectIssue);
  const dispatchImplementor = useStore(props.store, (s) => s.dispatchImplementor);
  const dispatchReviewer = useStore(props.store, (s) => s.dispatchReviewer);
  const cancelAgent = useStore(props.store, (s) => s.cancelAgent);
  const prDetails = useStore(props.store, (s) => s.prDetails);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const onPromptChange = props.onPromptChange;
  useEffect(() => {
    const message = prompt.type !== 'none' ? buildPromptMessage(prompt) : null;
    onPromptChange(message);
  }, [prompt, onPromptChange]);

  const sortedIssues = sortIssues(issues);
  const hasRunningAgent = sortedIssues.some((issue) => issue.agentRunning);

  useEffect(() => {
    if (!hasRunningAgent) {
      return;
    }
    const timer = setInterval(() => {
      setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [hasRunningAgent]);

  const selectedIndex = sortedIssues.findIndex((i) => i.number === selectedIssue);

  useInput(
    (input, key) => {
      if (!props.focused) {
        return;
      }

      const currentPrompt = promptRef.current;

      if (currentPrompt.type !== 'none') {
        if (input === 'y') {
          confirmPrompt(currentPrompt);
          setPrompt({ type: 'none' });
          return;
        }
        if (input === 'n' || key.escape) {
          setPrompt({ type: 'none' });
          return;
        }
        return;
      }

      if (sortedIssues.length === 0) {
        return;
      }

      const currentIndex = sortedIssues.findIndex((i) => i.number === selectedIssue);

      if (input === 'j' || key.downArrow) {
        const nextIndex = currentIndex < sortedIssues.length - 1 ? currentIndex + 1 : currentIndex;
        const nextIssue = sortedIssues[nextIndex];
        if (nextIssue) {
          selectIssue(nextIssue.number);
        }
        return;
      }

      if (input === 'k' || key.upArrow) {
        const nextIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        const nextIssue = sortedIssues[nextIndex];
        if (nextIssue) {
          selectIssue(nextIssue.number);
        }
        return;
      }

      if (key.return && !props.promptActive) {
        const selected = sortedIssues.find((i) => i.number === selectedIssue);
        if (!selected) {
          return;
        }
        handleEnter(selected);
        return;
      }
    },
    { isActive: props.focused },
  );

  function confirmPrompt(currentPrompt: PromptState): void {
    match(currentPrompt)
      .with({ type: 'dispatch' }, (p) => {
        dispatchImplementor(p.issueNumber);
      })
      .with({ type: 'cancel' }, (p) => {
        cancelAgent(p.issueNumber);
      })
      .with({ type: 'retry' }, (p) => {
        if (p.agentType === 'implementor') {
          dispatchImplementor(p.issueNumber);
        } else {
          dispatchReviewer(p.issueNumber);
        }
      })
      .with({ type: 'none' }, () => {
        /* no-op for dismissed prompt */
      })
      .exhaustive();
  }

  function handleEnter(issue: TrackedIssue): void {
    const action = getEnterAction(issue, prDetails, props.repository);

    match(action)
      .with({ type: 'dispatch' }, (a) => {
        setPrompt({ type: 'dispatch', issueNumber: a.issueNumber });
      })
      .with({ type: 'cancel' }, (a) => {
        setPrompt({ type: 'cancel', issueNumber: a.issueNumber });
      })
      .with({ type: 'retry' }, (a) => {
        setPrompt({ type: 'retry', issueNumber: a.issueNumber, agentType: a.agentType });
      })
      .with({ type: 'openURL' }, (a) => {
        props.onOpenURL(a.url);
      })
      .exhaustive();
  }

  if (sortedIssues.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No issues tracked</Text>
      </Box>
    );
  }

  const currentSpinner = SPINNER_FRAMES[spinnerFrame] ?? SPINNER_FRAMES[0];
  const items = buildIssueListItems(sortedIssues, currentSpinner);

  return (
    <List
      items={items}
      selectedIndex={selectedIndex}
      focused={props.focused}
      paneWidth={props.paneWidth}
      paneHeight={props.paneHeight}
      viewportOffset={props.viewportOffset}
      onViewportOffsetChange={props.onViewportOffsetChange}
      mouseScrolled={props.mouseScrolled}
      onMouseScrolledChange={props.onMouseScrolledChange}
    />
  );
}

function sortIssues(issues: Map<number, TrackedIssue>): TrackedIssue[] {
  return Array.from(issues.values()).sort((a, b) => {
    const aRunning = a.agentRunning ? 0 : 1;
    const bRunning = b.agentRunning ? 0 : 1;
    if (aRunning !== bRunning) {
      return aRunning - bRunning;
    }

    const aPriority = PRIORITY_ORDER[a.priorityLabel] ?? 1;
    const bPriority = PRIORITY_ORDER[b.priorityLabel] ?? 1;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    return a.createdAt.localeCompare(b.createdAt);
  });
}

function buildIssueListItems(
  sortedIssues: TrackedIssue[],
  spinnerChar: string,
): ListItemData[] {
  return sortedIssues.map((issue) => {
    const priority = getPriorityIndicator(issue.priorityLabel);
    const state = getStateIndicator(issue, spinnerChar);
    const content = `${priority} #${issue.number} ${issue.title} ${state}`;
    const richContent = buildRichIssueContent(issue, spinnerChar);
    return { key: String(issue.number), content, richContent };
  });
}

function buildRichIssueContent(issue: TrackedIssue, spinnerChar: string): ReactNode {
  const priority = getPriorityIndicator(issue.priorityLabel);
  const stateIndicator = getStateIndicatorElement(issue, spinnerChar);

  return (
    <>
      {priority} #{issue.number} {issue.title} {stateIndicator}
    </>
  );
}

function getStateIndicator(issue: TrackedIssue, spinnerChar: string): string {
  if (issue.lastFailure) {
    return ERROR_MARKER;
  }
  if (issue.agentRunning) {
    return spinnerChar;
  }

  return match(issue.statusLabel)
    .with('pending', () => READY_MARKER)
    .with('unblocked', () => READY_MARKER)
    .with('needs-changes', () => READY_MARKER)
    .with('in-progress', () => STALE_MARKER)
    .with('review', () => REVIEW_MARKER)
    .with('needs-refinement', () => BLOCKED_MARKER)
    .with('blocked', () => BLOCKED_MARKER)
    .with('approved', () => DONE_MARKER)
    .otherwise(() => '');
}

function getStateIndicatorElement(issue: TrackedIssue, spinnerChar: string): ReactNode {
  if (issue.lastFailure) {
    return <Text color="red">{ERROR_MARKER}</Text>;
  }
  if (issue.agentRunning) {
    return <Text color="cyan">{spinnerChar}</Text>;
  }

  return match(issue.statusLabel)
    .with('pending', () => <Text color="green">{READY_MARKER}</Text>)
    .with('unblocked', () => <Text color="green">{READY_MARKER}</Text>)
    .with('needs-changes', () => <Text color="green">{READY_MARKER}</Text>)
    .with('in-progress', () => <Text color="yellow">{STALE_MARKER}</Text>)
    .with('review', () => <Text color="cyan">{REVIEW_MARKER}</Text>)
    .with('needs-refinement', () => <Text color="yellow">{BLOCKED_MARKER}</Text>)
    .with('blocked', () => <Text color="yellow">{BLOCKED_MARKER}</Text>)
    .with('approved', () => <Text color="green">{DONE_MARKER}</Text>)
    .otherwise(() => <Text />);
}

function getPriorityIndicator(priorityLabel: string): string {
  return match(priorityLabel)
    .with('priority:high', () => '!!!')
    .with('priority:medium', () => '!! ')
    .with('priority:low', () => '!  ')
    .otherwise(() => '   ');
}

type EnterAction =
  | { type: 'dispatch'; issueNumber: number }
  | { type: 'cancel'; issueNumber: number }
  | { type: 'retry'; issueNumber: number; agentType: 'implementor' | 'reviewer' }
  | { type: 'openURL'; url: string };

function getEnterAction(
  issue: TrackedIssue,
  prDetailsMap: Map<number, CachedPRDetails>,
  repository: string,
): EnterAction {
  if (issue.lastFailure) {
    return { type: 'retry', issueNumber: issue.number, agentType: issue.lastFailure.agentType };
  }

  if (issue.agentRunning) {
    return { type: 'cancel', issueNumber: issue.number };
  }

  return match(issue.statusLabel)
    .with('pending', () => ({ type: 'dispatch' as const, issueNumber: issue.number }))
    .with('unblocked', () => ({ type: 'dispatch' as const, issueNumber: issue.number }))
    .with('needs-changes', () => ({ type: 'dispatch' as const, issueNumber: issue.number }))
    .with('review', () => {
      const pr = prDetailsMap.get(issue.number);
      const url = pr?.url ?? `https://github.com/${repository}/issues/${issue.number}`;
      return { type: 'openURL' as const, url };
    })
    .with('needs-refinement', () => ({
      type: 'openURL' as const,
      url: `https://github.com/${repository}/issues/${issue.number}`,
    }))
    .with('blocked', () => ({
      type: 'openURL' as const,
      url: `https://github.com/${repository}/issues/${issue.number}`,
    }))
    .with('approved', () => {
      const pr = prDetailsMap.get(issue.number);
      const url = pr?.url ?? `https://github.com/${repository}/issues/${issue.number}`;
      return { type: 'openURL' as const, url };
    })
    .otherwise(() => ({ type: 'dispatch' as const, issueNumber: issue.number }));
}

function buildPromptMessage(prompt: PromptState): string {
  return match(prompt)
    .with({ type: 'dispatch' }, (p) => `Dispatch Implementor for #${p.issueNumber}?`)
    .with({ type: 'cancel' }, (p) => `Cancel agent for #${p.issueNumber}?`)
    .with({ type: 'retry' }, (p) => {
      const label = p.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
      return `Retry ${label} for #${p.issueNumber}?`;
    })
    .with({ type: 'none' }, () => '')
    .exhaustive();
}
