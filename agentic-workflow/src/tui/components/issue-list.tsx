import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type { CachedPRDetails, EngineStore, TrackedIssue } from '../types';
import { ConfirmationPrompt } from './confirmation-prompt';

export type IssueListProps = {
  store: StoreApi<EngineStore>;
  focused: boolean;
  onOpenURL: (url: string) => void;
  repository: string;
  height: number;
};

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

export function IssueList({ store, focused, onOpenURL, repository, height }: IssueListProps) {
  const issues = useStore(store, (s) => s.issues);
  const selectedIssue = useStore(store, (s) => s.selectedIssue);
  const selectIssue = useStore(store, (s) => s.selectIssue);
  const dispatchImplementor = useStore(store, (s) => s.dispatchImplementor);
  const dispatchReviewer = useStore(store, (s) => s.dispatchReviewer);
  const cancelAgent = useStore(store, (s) => s.cancelAgent);
  const prDetails = useStore(store, (s) => s.prDetails);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const sortedIssues = sortIssues(issues);

  useInput(
    (input, key) => {
      if (!focused) return;

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

      if (sortedIssues.length === 0) return;

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

      if (key.return) {
        const selected = sortedIssues.find((i) => i.number === selectedIssue);
        if (!selected) return;
        handleEnter(selected);
        return;
      }
    },
    { isActive: focused },
  );

  function confirmPrompt(currentPrompt: PromptState) {
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
      .with({ type: 'none' }, () => {})
      .exhaustive();
  }

  function handleEnter(issue: TrackedIssue) {
    const action = getEnterAction(issue, prDetails, repository);

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
        onOpenURL(a.url);
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

  const currentIndex = sortedIssues.findIndex((i) => i.number === selectedIssue);
  const { start } = computeVisibleWindow(currentIndex, sortedIssues.length, height);
  const visibleIssues = sortedIssues.slice(start, start + height);

  return (
    <Box flexDirection="column">
      {prompt.type !== 'none' && <ConfirmationPrompt message={buildPromptMessage(prompt)} />}
      {visibleIssues.map((issue) => (
        <Text key={issue.number}>
          {issue.number === selectedIssue ? '> ' : '  '}
          {getPriorityIndicator(issue.priorityLabel)} #{issue.number} {issue.title}{' '}
          {getStateIndicator(issue)}
        </Text>
      ))}
    </Box>
  );
}

function sortIssues(issues: Map<number, TrackedIssue>): TrackedIssue[] {
  return Array.from(issues.values()).sort((a, b) => {
    const aRunning = a.agentRunning ? 0 : 1;
    const bRunning = b.agentRunning ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;

    const aPriority = PRIORITY_ORDER[a.priorityLabel] ?? 1;
    const bPriority = PRIORITY_ORDER[b.priorityLabel] ?? 1;
    if (aPriority !== bPriority) return aPriority - bPriority;

    return a.createdAt.localeCompare(b.createdAt);
  });
}

function getStateIndicator(issue: TrackedIssue): string {
  if (issue.lastFailure) return '[ERROR]';
  if (issue.agentRunning) return '[RUNNING]';

  return match(issue.statusLabel)
    .with('pending', () => '[READY]')
    .with('unblocked', () => '[READY]')
    .with('needs-changes', () => '[READY]')
    .with('in-progress', () => '[STALE]')
    .with('review', () => '[REVIEW]')
    .with('needs-refinement', () => '[BLOCKED]')
    .with('blocked', () => '[BLOCKED]')
    .with('approved', () => '[DONE]')
    .otherwise(() => '');
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
    .with({ type: 'dispatch' }, (p) => `Dispatch Implementor for #${p.issueNumber}? [y/n]`)
    .with({ type: 'cancel' }, (p) => `Cancel agent for #${p.issueNumber}? [y/n]`)
    .with({ type: 'retry' }, (p) => {
      const label = p.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
      return `Retry ${label} for #${p.issueNumber}? [y/n]`;
    })
    .with({ type: 'none' }, () => '')
    .exhaustive();
}

type VisibleWindow = {
  start: number;
};

function computeVisibleWindow(
  selectedIndex: number,
  totalCount: number,
  visibleRows: number,
): VisibleWindow {
  if (totalCount <= visibleRows) return { start: 0 };
  if (selectedIndex < 0) return { start: 0 };

  let start = 0;
  if (selectedIndex >= visibleRows) {
    start = selectedIndex - visibleRows + 1;
  }

  if (start + visibleRows > totalCount) {
    start = totalCount - visibleRows;
  }

  return { start };
}
