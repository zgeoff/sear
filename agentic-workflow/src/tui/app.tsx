import { spawn } from 'node:child_process';
import process from 'node:process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { match } from 'ts-pattern';
import { useStore } from 'zustand';
import type { Engine } from '../types.ts';
import { ConfirmationPrompt } from './components/confirmation-prompt.tsx';
import { DetailPane } from './components/detail-pane.tsx';
import { computeSectionCapacities, getVisibleTasks, IssueList } from './components/issue-list.tsx';
import { useEngine } from './hooks.ts';
import { selectRunningAgentCount, selectSortedTasks } from './store.ts';
import type { Task, TaskStatus } from './types.ts';

export interface AppProps {
  engine: Engine;
  repository: string;
}

type FocusedPane = 'taskList' | 'detailPane';

type PromptState =
  | { type: 'none' }
  | { type: 'quit' }
  | { type: 'dispatch'; issueNumber: number }
  | { type: 'retry'; issueNumber: number; agentType: 'implementor' | 'reviewer' };

const DEFAULT_TERMINAL_WIDTH = 80;
const DEFAULT_TERMINAL_HEIGHT = 24;
const LEFT_PANE_RATIO = 0.4;
const LEFT_PANE_MIN_COLS = 30;
const BORDER_COLUMNS = 1;
const HEADER_ROWS = 1;
const FOOTER_ROWS = 1;
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

const DISPATCHABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'ready-to-implement',
  'agent-crashed',
]);

export function App(props: AppProps): ReactNode {
  const engineStore = useEngine({ engine: props.engine });
  const [started, setStarted] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });
  const [spinnerFrame, setSpinnerFrame] = useState(0);

  const focusedPane = useStore(engineStore, (s) => s.focusedPane);
  const shuttingDown = useStore(engineStore, (s) => s.shuttingDown);
  const runningAgentCount = useStore(engineStore, selectRunningAgentCount);
  const plannerStatus = useStore(engineStore, (s) => s.plannerStatus);
  const cycleFocus = useStore(engineStore, (s) => s.cycleFocus);
  const shutdown = useStore(engineStore, (s) => s.shutdown);
  const tasks = useStore(engineStore, (s) => s.tasks);
  const selectedIssue = useStore(engineStore, (s) => s.selectedIssue);
  const pinnedTask = useStore(engineStore, (s) => s.pinnedTask);
  const selectIssue = useStore(engineStore, (s) => s.selectIssue);
  const pinTask = useStore(engineStore, (s) => s.pinTask);
  const dispatchAction = useStore(engineStore, (s) => s.dispatch);

  const { exit } = useApp();
  const { stdout } = useStdout();

  const terminalWidth = stdout?.columns ?? DEFAULT_TERMINAL_WIDTH;
  const terminalHeight = stdout?.rows ?? DEFAULT_TERMINAL_HEIGHT;
  const paneWidths = computePaneWidths(terminalWidth);
  const contentHeight = terminalHeight - HEADER_ROWS - FOOTER_ROWS;

  const sortedTasks = selectSortedTasks(tasks);
  const { actionCapacity, agentsCapacity } = computeSectionCapacities(contentHeight);
  const visibleTasks = getVisibleTasks(sortedTasks, actionCapacity, agentsCapacity);

  const selectedTask = selectedIssue !== null ? (tasks.get(selectedIssue) ?? null) : null;
  const pinnedTaskObj = pinnedTask !== null ? (tasks.get(pinnedTask) ?? null) : null;

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;

  const startupErrorRef = useRef(startupError);
  startupErrorRef.current = startupError;

  // Planner spinner animation
  useEffect(() => {
    if (plannerStatus !== 'running') {
      return;
    }
    const timer = setInterval(() => {
      setSpinnerFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [plannerStatus]);

  useEffect(() => {
    props.engine
      .start()
      .then(() => {
        setStarted(true);
      })
      .catch((error) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });
  }, [props.engine]);

  useEffect(() => {
    if (!shuttingDown) {
      return;
    }
    if (runningAgentCount === 0) {
      exit();
    }
  }, [shuttingDown, runningAgentCount, exit]);

  const handleOpenURL = useCallback(
    (task: Task | null) => {
      if (!task) {
        return;
      }
      const url = resolveTaskURL(task, props.repository);
      if (url) {
        openUrl(url);
      }
    },
    [props.repository],
  );

  const handleCopyURL = useCallback(
    (task: Task | null) => {
      if (!task) {
        return;
      }
      const url = resolveTaskURL(task, props.repository);
      if (url) {
        copyToClipboard(url);
      }
    },
    [props.repository],
  );

  // Refs for values used in useInput callback
  const visibleTasksRef = useRef(visibleTasks);
  visibleTasksRef.current = visibleTasks;

  const selectedIssueRef = useRef(selectedIssue);
  selectedIssueRef.current = selectedIssue;

  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;

  const pinnedTaskObjRef = useRef(pinnedTaskObj);
  pinnedTaskObjRef.current = pinnedTaskObj;

  useInput((input, key) => {
    if (startupErrorRef.current) {
      exit();
      return;
    }

    const currentPrompt = promptRef.current;

    // Confirmation prompt active — only y/n/Escape
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

    // Global keys
    if (key.tab) {
      cycleFocus();
      return;
    }
    if (input === 'q') {
      setPrompt({ type: 'quit' });
      return;
    }
    if (input === 'o') {
      const target = resolveTargetTask();
      handleOpenURL(target);
      return;
    }
    if (input === 'c') {
      const target = resolveTargetTask();
      handleCopyURL(target);
      return;
    }

    // Task list keys
    if (focusedPaneRef.current === 'taskList') {
      handleTaskListInput(input, key);
    }
  });

  function resolveTargetTask(): Task | null {
    if (focusedPaneRef.current === 'detailPane') {
      return pinnedTaskObjRef.current;
    }
    return selectedTaskRef.current;
  }

  function handleTaskListInput(
    input: string,
    key: { upArrow: boolean; downArrow: boolean; return: boolean },
  ): void {
    if (input === 'j' || key.downArrow) {
      navigateDown();
      return;
    }
    if (input === 'k' || key.upArrow) {
      navigateUp();
      return;
    }
    if (key.return) {
      const current = selectedIssueRef.current;
      if (current !== null) {
        pinTask(current);
      }
      return;
    }
    if (input === 'd') {
      handleDispatchKey();
    }
  }

  function navigateDown(): void {
    const currentVisibleTasks = visibleTasksRef.current;
    const currentSelected = selectedIssueRef.current;
    if (currentVisibleTasks.length === 0) {
      return;
    }
    if (currentSelected === null) {
      const first = currentVisibleTasks[0];
      if (first) {
        selectIssue(first.task.issueNumber);
      }
      return;
    }
    const currentIndex = currentVisibleTasks.findIndex(
      (st) => st.task.issueNumber === currentSelected,
    );
    if (currentIndex < 0) {
      const first = currentVisibleTasks[0];
      if (first) {
        selectIssue(first.task.issueNumber);
      }
      return;
    }
    if (currentIndex < currentVisibleTasks.length - 1) {
      const next = currentVisibleTasks[currentIndex + 1];
      if (next) {
        selectIssue(next.task.issueNumber);
      }
    }
  }

  function navigateUp(): void {
    const currentVisibleTasks = visibleTasksRef.current;
    const currentSelected = selectedIssueRef.current;
    if (currentVisibleTasks.length === 0) {
      return;
    }
    if (currentSelected === null) {
      const first = currentVisibleTasks[0];
      if (first) {
        selectIssue(first.task.issueNumber);
      }
      return;
    }
    const currentIndex = currentVisibleTasks.findIndex(
      (st) => st.task.issueNumber === currentSelected,
    );
    if (currentIndex < 0) {
      const first = currentVisibleTasks[0];
      if (first) {
        selectIssue(first.task.issueNumber);
      }
      return;
    }
    if (currentIndex > 0) {
      const prev = currentVisibleTasks[currentIndex - 1];
      if (prev) {
        selectIssue(prev.task.issueNumber);
      }
    }
  }

  function handleDispatchKey(): void {
    const currentTask = selectedTaskRef.current;
    if (!currentTask) {
      return;
    }
    if (!DISPATCHABLE_STATUSES.has(currentTask.status)) {
      return;
    }
    if (currentTask.status === 'agent-crashed' && currentTask.agent) {
      const agentType = currentTask.agent.type;
      setPrompt({ type: 'retry', issueNumber: currentTask.issueNumber, agentType });
      return;
    }
    setPrompt({ type: 'dispatch', issueNumber: currentTask.issueNumber });
  }

  function confirmPrompt(currentPrompt: PromptState): void {
    match(currentPrompt)
      .with({ type: 'dispatch' }, (p) => {
        dispatchAction(p.issueNumber);
      })
      .with({ type: 'retry' }, (p) => {
        dispatchAction(p.issueNumber);
      })
      .with({ type: 'quit' }, () => {
        shutdown();
      })
      .with({ type: 'none' }, () => {
        /* no-op */
      })
      .exhaustive();
  }

  if (startupError) {
    return (
      <Box
        width={terminalWidth}
        height={terminalHeight}
        alignItems="center"
        justifyContent="center"
        flexDirection="column"
      >
        <Text color="red">Startup failed: {startupError}</Text>
        <Text dimColor={true}>Press any key to exit.</Text>
      </Box>
    );
  }

  if (shuttingDown) {
    return (
      <Box
        width={terminalWidth}
        height={terminalHeight}
        alignItems="center"
        justifyContent="center"
      >
        <Text>
          {runningAgentCount > 0
            ? `Shutting down... waiting for ${runningAgentCount} agent(s)`
            : 'Shutting down...'}
        </Text>
      </Box>
    );
  }

  if (!started) {
    return (
      <Box
        width={terminalWidth}
        height={terminalHeight}
        alignItems="center"
        justifyContent="center"
      >
        <Text>Starting engine...</Text>
      </Box>
    );
  }

  const promptMessage = buildPromptMessage(prompt, runningAgentCount);
  const dispatchDimmed = !(selectedTask && DISPATCHABLE_STATUSES.has(selectedTask.status));

  return (
    <Box width={terminalWidth} height={terminalHeight} flexDirection="column">
      <HeaderBar
        plannerStatus={plannerStatus}
        spinnerFrame={spinnerFrame}
        terminalWidth={terminalWidth}
      />
      <Box flexDirection="row" height={contentHeight}>
        <Box width={paneWidths[0]} height={contentHeight} flexDirection="column">
          <IssueList store={engineStore} paneWidth={paneWidths[0]} paneHeight={contentHeight} />
        </Box>
        <Text>│</Text>
        <Box width={paneWidths[1]} height={contentHeight} flexDirection="column">
          <DetailPane store={engineStore} paneWidth={paneWidths[1]} paneHeight={contentHeight} />
        </Box>
      </Box>
      <FooterBar focusedPane={focusedPane} dispatchDimmed={dispatchDimmed} />
      {promptMessage !== null ? (
        <ConfirmationPrompt
          message={promptMessage}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
        />
      ) : null}
    </Box>
  );
}

export function computePaneWidths(terminalWidth: number): readonly [number, number] {
  const contentWidth = terminalWidth - BORDER_COLUMNS;
  const leftWidth = Math.max(LEFT_PANE_MIN_COLS, Math.floor(contentWidth * LEFT_PANE_RATIO));
  const rightWidth = Math.max(0, contentWidth - leftWidth);
  return [leftWidth, rightWidth];
}

// ---------------------------------------------------------------------------
// Header Bar
// ---------------------------------------------------------------------------

interface HeaderBarProps {
  plannerStatus: 'idle' | 'running';
  spinnerFrame: number;
  terminalWidth: number;
}

function HeaderBar(props: HeaderBarProps): ReactNode {
  // biome-ignore lint/security/noSecrets: emoji character, not a secret
  const IDLE_EMOJI = '\uD83D\uDCA4';
  const indicator =
    props.plannerStatus === 'running'
      ? (SPINNER_FRAMES[props.spinnerFrame] ?? '\u280B')
      : IDLE_EMOJI;

  return (
    <Box width={props.terminalWidth} justifyContent="flex-end">
      <Text>planner {indicator}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Footer Bar
// ---------------------------------------------------------------------------

interface FooterBarProps {
  focusedPane: FocusedPane;
  dispatchDimmed: boolean;
}

function FooterBar(props: FooterBarProps): ReactNode {
  if (props.focusedPane === 'taskList') {
    return (
      <Box>
        <Text>
          {'↑↓jk select    <enter> pin    '}
          <Text dimColor={props.dispatchDimmed}>[d]ispatch</Text>
          {'    '}[o]pen [c]opy [q]uit
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>↑↓jk scroll {'<tab>'} back [o]pen [c]opy [q]uit</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// URL Resolution
// ---------------------------------------------------------------------------

export function resolveTaskURL(task: Task, repository: string): string | null {
  const issueURL = `https://github.com/${repository}/issues/${task.issueNumber}`;
  const firstPR = task.prs[0];
  const firstPRURL = firstPR?.url || null;

  return match(task.status)
    .with('ready-to-implement', () => issueURL)
    .with('needs-refinement', () => issueURL)
    .with('blocked', () => issueURL)
    .with('agent-crashed', () => issueURL)
    .with('agent-implementing', () => firstPRURL ?? issueURL)
    .with('agent-reviewing', () => firstPRURL ?? issueURL)
    .with('ready-to-merge', () => firstPRURL ?? issueURL)
    .exhaustive();
}

// ---------------------------------------------------------------------------
// Prompt Messages
// ---------------------------------------------------------------------------

function buildPromptMessage(prompt: PromptState, runningAgentCount: number): string | null {
  return match(prompt)
    .with({ type: 'dispatch' }, (p) => `Dispatch Implementor for #${p.issueNumber}?`)
    .with({ type: 'retry' }, (p) => {
      const label = p.agentType === 'implementor' ? 'Implementor' : 'Reviewer';
      return `Retry ${label} for #${p.issueNumber}?`;
    })
    .with({ type: 'quit' }, () => {
      if (runningAgentCount > 0) {
        return `Quit? ${runningAgentCount} agent(s) running.`;
      }
      return 'Quit?';
    })
    .with({ type: 'none' }, () => null)
    .exhaustive();
}

// ---------------------------------------------------------------------------
// System Interaction
// ---------------------------------------------------------------------------

function openUrl(url: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore' });
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    return;
  }
  spawn('xdg-open', [url], { stdio: 'ignore' });
}

function copyToClipboard(text: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(text);
    child.stdin.end();
    return;
  }
  if (platform === 'win32') {
    const child = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(text);
    child.stdin.end();
    return;
  }
  const child = spawn('xclip', ['-selection', 'clipboard'], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.write(text);
  child.stdin.end();
}
