import { spawn } from 'node:child_process';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { Engine, StartupResult } from '../types';
import { ConfirmationPrompt } from './components/confirmation-prompt';
import { DetailPane } from './components/detail-pane';
import { IssueList } from './components/issue-list';
import { handleNotificationsInput, NotificationsPane } from './components/notifications';
import { useEngine } from './hooks';
import { selectRunningAgentCount } from './store';
import type { FocusedPane } from './types';

export type AppProps = {
  engine: Engine;
  repository: string;
};

type PromptState = { type: 'none' } | { type: 'quit'; previousPane: FocusedPane };

export function App(props: AppProps) {
  const engineStore = useEngine({ engine: props.engine, repository: props.repository });
  const [startupResult, setStartupResult] = useState<StartupResult | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });
  const [issueListPromptMessage, setIssueListPromptMessage] = useState<string | null>(null);
  const [selectedNotificationIndex, setSelectedNotificationIndex] = useState(0);

  const focusedPane = useStore(engineStore, (s) => s.focusedPane);
  const shuttingDown = useStore(engineStore, (s) => s.shuttingDown);
  const runningAgentCount = useStore(engineStore, selectRunningAgentCount);
  const notifications = useStore(engineStore, (s) => s.notifications);
  const storeRepository = useStore(engineStore, (s) => s.repository);
  const cycleFocus = useStore(engineStore, (s) => s.cycleFocus);
  const shutdown = useStore(engineStore, (s) => s.shutdown);

  const { exit } = useApp();
  const { stdout } = useStdout();

  const terminalWidth = stdout?.columns ?? 80;
  const terminalHeight = stdout?.rows ?? 24;
  const paneWidth = Math.floor(terminalWidth / 3);

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
        setStartupResult(result);
      })
      .catch((error) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });
  }, [props.engine]);

  useEffect(() => {
    if (!shuttingDown) return;
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

    if (issueListPromptMessageRef.current !== null) return;

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
      if (promptRef.current.type !== 'none' || issueListPromptMessageRef.current !== null) return;
      handleNotificationsInput(
        input,
        key,
        notifications,
        selectedNotificationIndex,
        setSelectedNotificationIndex,
        openURL,
        copyToClipboard,
      );
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
        <Text dimColor>Press any key to exit.</Text>
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

  if (!startupResult) {
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

  const startupNotification = buildStartupNotification(startupResult);

  return (
    <Box width={terminalWidth} height={terminalHeight} flexDirection="row">
      <Box width={paneWidth} height={terminalHeight} flexDirection="column">
        <NotificationsPane
          notifications={notifications}
          focused={focusedPane === 'notifications'}
          selectedIndex={selectedNotificationIndex}
          repository={storeRepository}
        />
        {startupNotification && <Text>{startupNotification}</Text>}
      </Box>
      <Box width={paneWidth} height={terminalHeight} flexDirection="column">
        <IssueList
          store={engineStore}
          focused={focusedPane === 'issueList'}
          onOpenURL={openURL}
          repository={props.repository}
          height={terminalHeight}
          promptActive={prompt.type !== 'none'}
          onPromptChange={handleIssueListPromptChange}
        />
      </Box>
      <Box width={paneWidth} height={terminalHeight} flexDirection="column">
        <DetailPane store={engineStore} />
      </Box>
      {anyPromptActive && activePromptMessage && (
        <ConfirmationPrompt
          message={activePromptMessage}
          terminalWidth={terminalWidth}
          terminalHeight={terminalHeight}
        />
      )}
    </Box>
  );
}

function buildStartupNotification(result: StartupResult): string {
  const parts = [`Startup complete: ${result.issueCount} issues tracked`];
  if (result.recoveriesPerformed > 0) {
    parts.push(`${result.recoveriesPerformed} recoveries performed`);
  }
  return parts.join(', ');
}

function buildQuitMessage(runningAgentCount: number): string {
  if (runningAgentCount > 0) {
    return `Quit? ${runningAgentCount} agent(s) running.`;
  }
  return 'Quit?';
}

function openURL(url: string) {
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

function copyToClipboard(text: string) {
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
