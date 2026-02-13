import { spawn } from 'node:child_process';
import process from 'node:process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { Engine } from '../types.ts';
import { ConfirmationPrompt } from './components/confirmation-prompt.tsx';
import { DetailPane } from './components/detail-pane.tsx';
import { IssueList } from './components/issue-list.tsx';
import { useEngine } from './hooks.ts';
import { selectRunningAgentCount } from './store.ts';

export interface AppProps {
  engine: Engine;
  repository: string;
}

type FocusedPane = 'taskList' | 'detailPane';

type PromptState = { type: 'none' } | { type: 'quit'; previousPane: FocusedPane };

const DEFAULT_TERMINAL_WIDTH = 80;
const DEFAULT_TERMINAL_HEIGHT = 24;
const PANE_COUNT = 2;
const BORDER_COLUMNS = 3;
const BORDER_ROWS = 2;

const PANE_LABELS: readonly string[] = ['TASKS', 'DETAILS'];

export function App(props: AppProps): ReactNode {
  const engineStore = useEngine({ engine: props.engine });
  const [started, setStarted] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });
  const [issueListPromptMessage, setIssueListPromptMessage] = useState<string | null>(null);
  const [issueListViewportOffset, setIssueListViewportOffset] = useState(0);
  const [issueListMouseScrolled, setIssueListMouseScrolled] = useState(false);

  const focusedPane = useStore(engineStore, (s) => s.focusedPane);
  const shuttingDown = useStore(engineStore, (s) => s.shuttingDown);
  const runningAgentCount = useStore(engineStore, selectRunningAgentCount);
  const cycleFocus = useStore(engineStore, (s) => s.cycleFocus);
  const shutdown = useStore(engineStore, (s) => s.shutdown);

  const { exit } = useApp();
  const { stdout } = useStdout();

  const terminalWidth = stdout?.columns ?? DEFAULT_TERMINAL_WIDTH;
  const terminalHeight = stdout?.rows ?? DEFAULT_TERMINAL_HEIGHT;
  const paneWidths = computePaneWidths(terminalWidth);
  const contentHeight = terminalHeight - BORDER_ROWS;

  const anyPromptActive = prompt.type !== 'none' || issueListPromptMessage !== null;
  const activePromptMessage =
    prompt.type === 'quit' ? buildQuitMessage(runningAgentCount) : issueListPromptMessage;

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const issueListPromptMessageRef = useRef(issueListPromptMessage);
  issueListPromptMessageRef.current = issueListPromptMessage;

  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;

  const handleIssueListPromptChange = useCallback((message: string | null) => {
    setIssueListPromptMessage(message);
  }, []);

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

  const startupErrorRef = useRef(startupError);
  startupErrorRef.current = startupError;

  useInput((input, key) => {
    if (startupErrorRef.current) {
      exit();
      return;
    }

    const currentPrompt = promptRef.current;

    if (currentPrompt.type === 'quit') {
      if (input === 'y') {
        setPrompt({ type: 'none' });
        shutdown();
        return;
      }
      if (input === 'n' || key.escape) {
        setPrompt({ type: 'none' });
        return;
      }
      return;
    }

    if (issueListPromptMessageRef.current !== null) {
      return;
    }

    if (key.tab) {
      cycleFocus();
      return;
    }
    if (input === 'q') {
      setPrompt({ type: 'quit', previousPane: focusedPaneRef.current });
      return;
    }
  });

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
        <Text>Shutting down... waiting for {runningAgentCount} agent(s)</Text>
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

  const panesFocused = getPaneFocusStates(focusedPane);

  return (
    <Box width={terminalWidth} height={terminalHeight} flexDirection="column">
      <Box>
        <TopBorder paneWidths={paneWidths} panesFocused={panesFocused} />
      </Box>
      <Box flexDirection="row" height={contentHeight}>
        <Text dimColor={!panesFocused[0]}>│</Text>
        <Box width={paneWidths[0]} height={contentHeight} flexDirection="column">
          <IssueList
            store={engineStore}
            focused={focusedPane === 'taskList'}
            onOpenURL={openUrl}
            repository={props.repository}
            paneWidth={paneWidths[0]}
            paneHeight={contentHeight}
            viewportOffset={issueListViewportOffset}
            onViewportOffsetChange={setIssueListViewportOffset}
            mouseScrolled={issueListMouseScrolled}
            onMouseScrolledChange={setIssueListMouseScrolled}
            promptActive={prompt.type !== 'none'}
            onPromptChange={handleIssueListPromptChange}
          />
        </Box>
        <Text dimColor={!(panesFocused[0] || panesFocused[1])}>│</Text>
        <Box width={paneWidths[1]} height={contentHeight} flexDirection="column">
          <DetailPane store={engineStore} paneWidth={paneWidths[1]} paneHeight={contentHeight} />
        </Box>
        <Text dimColor={!panesFocused[1]}>│</Text>
      </Box>
      <Box>
        <BottomBorder paneWidths={paneWidths} panesFocused={panesFocused} />
      </Box>
      {anyPromptActive && activePromptMessage !== null ? (
        <ConfirmationPrompt
          message={activePromptMessage}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
        />
      ) : null}
    </Box>
  );
}

export function computePaneWidths(terminalWidth: number): readonly [number, number] {
  const contentWidth = terminalWidth - BORDER_COLUMNS;
  const baseWidth = Math.floor(contentWidth / PANE_COUNT);
  const remainder = contentWidth - baseWidth * PANE_COUNT;
  return [baseWidth, baseWidth + remainder];
}

interface TopBorderProps {
  paneWidths: readonly [number, number];
  panesFocused: readonly [boolean, boolean];
}

function TopBorder(props: TopBorderProps): ReactNode {
  return (
    <Text>
      <Text dimColor={!props.panesFocused[0]}>
        {`\u250c${buildTopSegment(PANE_LABELS[0] ?? '', props.paneWidths[0])}`}
      </Text>
      <Text dimColor={!(props.panesFocused[0] || props.panesFocused[1])}>┬</Text>
      <Text dimColor={!props.panesFocused[1]}>
        {`${buildTopSegment(PANE_LABELS[1] ?? '', props.paneWidths[1])}\u2510`}
      </Text>
    </Text>
  );
}

interface BottomBorderProps {
  paneWidths: readonly [number, number];
  panesFocused: readonly [boolean, boolean];
}

function BottomBorder(props: BottomBorderProps): ReactNode {
  return (
    <Text>
      <Text dimColor={!props.panesFocused[0]}>
        {`\u2514${'\u2500'.repeat(props.paneWidths[0])}`}
      </Text>
      <Text dimColor={!(props.panesFocused[0] || props.panesFocused[1])}>┴</Text>
      <Text dimColor={!props.panesFocused[1]}>
        {`${'\u2500'.repeat(props.paneWidths[1])}\u2518`}
      </Text>
    </Text>
  );
}

function buildTopSegment(label: string, width: number): string {
  const prefix = ` ${label} `;
  const fillLength = width - prefix.length;
  if (fillLength <= 0) {
    return prefix.slice(0, width);
  }
  return prefix + '\u2500'.repeat(fillLength);
}

function getPaneFocusStates(focusedPane: FocusedPane): readonly [boolean, boolean] {
  return [focusedPane === 'taskList', focusedPane === 'detailPane'];
}

function buildQuitMessage(runningAgentCount: number): string {
  if (runningAgentCount > 0) {
    return `Quit? ${runningAgentCount} agent(s) running.`;
  }
  return 'Quit?';
}

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
