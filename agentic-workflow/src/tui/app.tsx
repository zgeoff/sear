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
import { handleNotificationsInput, NotificationsPane } from './components/notifications.tsx';
import { useEngine } from './hooks.ts';
import { selectRunningAgentCount } from './store.ts';
import type { FocusedPane } from './types.ts';

export interface AppProps {
  engine: Engine;
  repository: string;
}

type PromptState = { type: 'none' } | { type: 'quit'; previousPane: FocusedPane };

const DEFAULT_TERMINAL_WIDTH = 80;
const DEFAULT_TERMINAL_HEIGHT = 24;
const PANE_COUNT = 3;
const BORDER_COLUMNS = 4;
const BORDER_ROWS = 2;

const PANE_LABELS: readonly string[] = ['NOTIFICATIONS', 'ISSUES', 'DETAILS'];

export function App(props: AppProps): ReactNode {
  const engineStore = useEngine({ engine: props.engine, repository: props.repository });
  const [started, setStarted] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });
  const [issueListPromptMessage, setIssueListPromptMessage] = useState<string | null>(null);
  const [selectedNotificationIndex, setSelectedNotificationIndex] = useState(0);
  const [notificationViewportOffset, setNotificationViewportOffset] = useState(0);
  const [notificationMouseScrolled, setNotificationMouseScrolled] = useState(false);

  const focusedPane = useStore(engineStore, (s) => s.focusedPane);
  const shuttingDown = useStore(engineStore, (s) => s.shuttingDown);
  const runningAgentCount = useStore(engineStore, selectRunningAgentCount);
  const notifications = useStore(engineStore, (s) => s.notifications);
  const cycleFocus = useStore(engineStore, (s) => s.cycleFocus);
  const shutdown = useStore(engineStore, (s) => s.shutdown);
  const handleStartup = useStore(engineStore, (s) => s.handleStartup);

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
      .then((result) => {
        handleStartup(result);
        setStarted(true);
      })
      .catch((error) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });
  }, [props.engine, handleStartup]);

  useEffect(() => {
    if (!shuttingDown) {
      return;
    }
    if (runningAgentCount === 0) {
      exit();
    }
  }, [shuttingDown, runningAgentCount, exit]);

  const previousNotificationCountRef = useRef(notifications.length);
  useEffect(() => {
    const previousCount = previousNotificationCountRef.current;
    previousNotificationCountRef.current = notifications.length;

    if (notifications.length <= previousCount) {
      return;
    }

    const newOffset = computeAutoScrollOffset(notificationViewportOffset, contentHeight);
    setNotificationViewportOffset(newOffset);
  }, [notifications.length, notificationViewportOffset, contentHeight]);

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

    if (key.tab && key.shift) {
      cycleFocus('backward');
      return;
    }
    if (key.tab) {
      cycleFocus('forward');
      return;
    }
    if (input === 'q') {
      setPrompt({ type: 'quit', previousPane: focusedPaneRef.current });
      return;
    }
  });

  useInput(
    (input, key) => {
      if (promptRef.current.type !== 'none' || issueListPromptMessageRef.current !== null) {
        return;
      }
      handleNotificationsInput({
        input,
        key,
        notifications,
        selectedIndex: selectedNotificationIndex,
        onSelectIndex: setSelectedNotificationIndex,
        openUrl,
        copyToClipboard,
      });
    },
    { isActive: focusedPane === 'notifications' },
  );

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
          <NotificationsPane
            notifications={notifications}
            repository={props.repository}
            focused={focusedPane === 'notifications'}
            selectedIndex={selectedNotificationIndex}
            paneWidth={paneWidths[0]}
            paneHeight={contentHeight}
            viewportOffset={notificationViewportOffset}
            onViewportOffsetChange={setNotificationViewportOffset}
            mouseScrolled={notificationMouseScrolled}
            onMouseScrolledChange={setNotificationMouseScrolled}
          />
        </Box>
        <Text dimColor={!(panesFocused[0] || panesFocused[1])}>│</Text>
        <Box width={paneWidths[1]} height={contentHeight} flexDirection="column">
          <IssueList
            store={engineStore}
            focused={focusedPane === 'issueList'}
            onOpenURL={openUrl}
            repository={props.repository}
            height={contentHeight}
            promptActive={prompt.type !== 'none'}
            onPromptChange={handleIssueListPromptChange}
          />
        </Box>
        <Text dimColor={!(panesFocused[1] || panesFocused[2])}>│</Text>
        <Box width={paneWidths[2]} height={contentHeight} flexDirection="column">
          <DetailPane store={engineStore} paneWidth={paneWidths[2]} paneHeight={contentHeight} />
        </Box>
        <Text dimColor={!panesFocused[2]}>│</Text>
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

export function computePaneWidths(terminalWidth: number): readonly [number, number, number] {
  const contentWidth = terminalWidth - BORDER_COLUMNS;
  const baseWidth = Math.floor(contentWidth / PANE_COUNT);
  const remainder = contentWidth - baseWidth * PANE_COUNT;
  return [baseWidth, baseWidth, baseWidth + remainder];
}

interface TopBorderProps {
  paneWidths: readonly [number, number, number];
  panesFocused: readonly [boolean, boolean, boolean];
}

function TopBorder(props: TopBorderProps): ReactNode {
  return (
    <Text>
      <Text dimColor={!props.panesFocused[0]}>
        {`\u250c${buildTopSegment(PANE_LABELS[0] ?? '', props.paneWidths[0])}`}
      </Text>
      <Text dimColor={!(props.panesFocused[0] || props.panesFocused[1])}>┬</Text>
      <Text dimColor={!props.panesFocused[1]}>
        {buildTopSegment(PANE_LABELS[1] ?? '', props.paneWidths[1])}
      </Text>
      <Text dimColor={!(props.panesFocused[1] || props.panesFocused[2])}>┬</Text>
      <Text dimColor={!props.panesFocused[2]}>
        {`${buildTopSegment(PANE_LABELS[2] ?? '', props.paneWidths[2])}\u2510`}
      </Text>
    </Text>
  );
}

interface BottomBorderProps {
  paneWidths: readonly [number, number, number];
  panesFocused: readonly [boolean, boolean, boolean];
}

function BottomBorder(props: BottomBorderProps): ReactNode {
  return (
    <Text>
      <Text dimColor={!props.panesFocused[0]}>
        {`\u2514${'\u2500'.repeat(props.paneWidths[0])}`}
      </Text>
      <Text dimColor={!(props.panesFocused[0] || props.panesFocused[1])}>┴</Text>
      <Text dimColor={!props.panesFocused[1]}>{'\u2500'.repeat(props.paneWidths[1])}</Text>
      <Text dimColor={!(props.panesFocused[1] || props.panesFocused[2])}>┴</Text>
      <Text dimColor={!props.panesFocused[2]}>
        {`${'\u2500'.repeat(props.paneWidths[2])}\u2518`}
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

function getPaneFocusStates(focusedPane: FocusedPane): readonly [boolean, boolean, boolean] {
  return [
    focusedPane === 'notifications',
    focusedPane === 'issueList',
    focusedPane === 'detailPane',
  ];
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

function copyToClipboard(text: string): void {
  const platform = process.platform;
  let proc: ReturnType<typeof spawn>;
  if (platform === 'darwin') {
    proc = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
  } else if (platform === 'win32') {
    proc = spawn('clip', { stdio: ['pipe', 'ignore', 'ignore'] });
  } else {
    proc = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
  }
  proc.stdin?.write(text);
  proc.stdin?.end();
}

export function computeAutoScrollOffset(currentOffset: number, visibleItemCount: number): number {
  if (currentOffset < visibleItemCount) {
    return 0;
  }
  return currentOffset + 1;
}
