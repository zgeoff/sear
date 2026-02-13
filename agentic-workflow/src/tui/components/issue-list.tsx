import { Box, Text, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { match } from 'ts-pattern';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import { selectSortedTasks } from '../store.ts';
import type { Task, TUIStore } from '../types.ts';
import { List } from './list/list.tsx';
import type { ListItemData } from './list/types.ts';

export type IssueListPromptChangeHandler = (message: string | null) => void;

export interface IssueListProps {
  store: StoreApi<TUIStore>;
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
  | { type: 'dispatch'; issueNumber: number; hasCIFailure: boolean }
  | { type: 'cancel'; issueNumber: number }
  | { type: 'retry'; issueNumber: number; agentType: 'implementor' | 'reviewer' };

const SPINNER_FRAMES: readonly string[] = [
  '\u280B',
  '\u2819',
  '\u2839',
  '\u2838',
  '\u283C',
  '\u2834',
  '\u2826',
  '\u2827',
  '\u2807',
  '\u280F',
];
const SPINNER_INTERVAL_MS = 80;

const READY_MARKER = '\u25CF';
const STALE_MARKER = '\u25CB';
const REVIEW_MARKER = '\u25B6';
const BLOCKED_MARKER = '\u26A0';
const DONE_MARKER = '\u2713';
const ERROR_MARKER = '\u2717';
const CI_MARKER = '\u274C';

export function IssueList(props: IssueListProps): ReactNode {
  const tasks = useStore(props.store, (s) => s.tasks);
  const selectedIssue = useStore(props.store, (s) => s.selectedIssue);
  const selectIssue = useStore(props.store, (s) => s.selectIssue);
  const dispatch = useStore(props.store, (s) => s.dispatch);
  const cancelAgent = useStore(props.store, (s) => s.cancelAgent);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const onPromptChange = props.onPromptChange;
  useEffect(() => {
    const message = prompt.type !== 'none' ? buildPromptMessage(prompt) : null;
    onPromptChange(message);
  }, [prompt, onPromptChange]);

  const sortedTasks = selectSortedTasks(tasks);
  const sortedTaskList = sortedTasks.map((st) => st.task);
  const hasRunningAgent = sortedTaskList.some((task) => task.agent?.running === true);

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

  const selectedIndex = sortedTaskList.findIndex((t) => t.issueNumber === selectedIssue);

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

      if (sortedTaskList.length === 0) {
        return;
      }

      const currentIndex = sortedTaskList.findIndex((t) => t.issueNumber === selectedIssue);

      if (input === 'j' || key.downArrow) {
        const nextIndex =
          currentIndex < sortedTaskList.length - 1 ? currentIndex + 1 : currentIndex;
        const nextTask = sortedTaskList[nextIndex];
        if (nextTask) {
          selectIssue(nextTask.issueNumber);
        }
        return;
      }

      if (input === 'k' || key.upArrow) {
        const nextIndex = currentIndex > 0 ? currentIndex - 1 : 0;
        const nextTask = sortedTaskList[nextIndex];
        if (nextTask) {
          selectIssue(nextTask.issueNumber);
        }
        return;
      }

      if (key.return && !props.promptActive) {
        const selected = sortedTaskList.find((t) => t.issueNumber === selectedIssue);
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
        dispatch(p.issueNumber);
      })
      .with({ type: 'cancel' }, (p) => {
        cancelAgent(p.issueNumber);
      })
      .with({ type: 'retry' }, (p) => {
        dispatch(p.issueNumber);
      })
      .with({ type: 'none' }, () => {
        /* no-op for dismissed prompt */
      })
      .exhaustive();
  }

  function handleEnter(task: Task): void {
    const action = getEnterAction(task, props.repository);

    match(action)
      .with({ type: 'dispatch' }, (a) => {
        const hasCIFailure = task.prs.some((pr) => pr.ciStatus === 'failure');
        setPrompt({
          type: 'dispatch',
          issueNumber: a.issueNumber,
          hasCIFailure,
        });
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

  if (sortedTaskList.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No issues tracked</Text>
      </Box>
    );
  }

  const currentSpinner = SPINNER_FRAMES[spinnerFrame] ?? '\u280B';
  const items = buildTaskListItems(sortedTaskList, currentSpinner);

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

function buildTaskListItems(sortedTasks: Task[], spinnerChar: string): ListItemData[] {
  return sortedTasks.map((task) => {
    const priority = getPriorityIndicator(task.priority);
    const state = getStateIndicator(task, spinnerChar);
    const content = `${priority} #${task.issueNumber} ${task.title} ${state}`;
    const richContent = buildRichTaskContent(task, spinnerChar);
    return { key: String(task.issueNumber), content, richContent };
  });
}

function buildRichTaskContent(task: Task, spinnerChar: string): ReactNode {
  const priority = getPriorityIndicator(task.priority);
  const stateIndicator = getStateIndicatorElement(task, spinnerChar);

  return (
    <>
      {priority} #{task.issueNumber} {task.title} {stateIndicator}
    </>
  );
}

function getStateIndicator(task: Task, spinnerChar: string): string {
  let baseIndicator = '';

  if (task.agent?.crash) {
    baseIndicator = ERROR_MARKER;
  } else if (task.agent?.running === true) {
    baseIndicator = spinnerChar;
  } else {
    baseIndicator = match(task.statusLabel)
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

  const hasCIFailure = task.prs.some((pr) => pr.ciStatus === 'failure');
  const ciIndicator = hasCIFailure ? ` ${CI_MARKER}` : '';
  return `${baseIndicator}${ciIndicator}`;
}

function getStateIndicatorElement(task: Task, spinnerChar: string): ReactNode {
  let baseIndicator: ReactNode = null;

  if (task.agent?.crash) {
    baseIndicator = <Text color="red">{ERROR_MARKER}</Text>;
  } else if (task.agent?.running === true) {
    baseIndicator = <Text color="cyan">{spinnerChar}</Text>;
  } else {
    baseIndicator = match(task.statusLabel)
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

  const hasCIFailure = task.prs.some((pr) => pr.ciStatus === 'failure');
  const ciIndicator = hasCIFailure ? <Text color="red"> {CI_MARKER}</Text> : null;

  return (
    <>
      {baseIndicator}
      {ciIndicator}
    </>
  );
}

function getPriorityIndicator(priority: string | null): string {
  if (priority === null) {
    return '   ';
  }
  return match(priority)
    .with('high', () => '!!!')
    .with('medium', () => '!! ')
    .with('low', () => '!  ')
    .otherwise(() => '   ');
}

type EnterAction =
  | { type: 'dispatch'; issueNumber: number }
  | { type: 'cancel'; issueNumber: number }
  | { type: 'retry'; issueNumber: number; agentType: 'implementor' | 'reviewer' }
  | { type: 'openURL'; url: string };

function getEnterAction(task: Task, repository: string): EnterAction {
  if (task.agent?.crash && task.agent.type) {
    return { type: 'retry', issueNumber: task.issueNumber, agentType: task.agent.type };
  }

  if (task.agent?.running === true) {
    return { type: 'cancel', issueNumber: task.issueNumber };
  }

  return match(task.statusLabel)
    .with('pending', () => ({ type: 'dispatch' as const, issueNumber: task.issueNumber }))
    .with('unblocked', () => ({ type: 'dispatch' as const, issueNumber: task.issueNumber }))
    .with('needs-changes', () => ({ type: 'dispatch' as const, issueNumber: task.issueNumber }))
    .with('review', () => {
      const pr = task.prs[0];
      const url = pr?.url || `https://github.com/${repository}/issues/${task.issueNumber}`;
      return { type: 'openURL' as const, url };
    })
    .with('needs-refinement', () => ({
      type: 'openURL' as const,
      url: `https://github.com/${repository}/issues/${task.issueNumber}`,
    }))
    .with('blocked', () => ({
      type: 'openURL' as const,
      url: `https://github.com/${repository}/issues/${task.issueNumber}`,
    }))
    .with('approved', () => {
      const pr = task.prs[0];
      const url = pr?.url || `https://github.com/${repository}/issues/${task.issueNumber}`;
      return { type: 'openURL' as const, url };
    })
    .otherwise(() => ({ type: 'dispatch' as const, issueNumber: task.issueNumber }));
}

function buildPromptMessage(prompt: PromptState): string {
  return match(prompt)
    .with({ type: 'dispatch' }, (p) => {
      const base = `Dispatch Implementor for #${p.issueNumber}?`;
      const ciSuffix = p.hasCIFailure ? ' (CI failed)' : '';
      return `${base}${ciSuffix}`;
    })
    .with({ type: 'cancel' }, (p) => `Cancel agent for #${p.issueNumber}?`)
    .with({ type: 'retry' }, (p) => {
      const label = p.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
      return `Retry ${label} for #${p.issueNumber}?`;
    })
    .with({ type: 'none' }, () => '')
    .exhaustive();
}
