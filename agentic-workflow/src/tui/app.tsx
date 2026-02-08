import { Box, Text, useApp, useInput } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { Engine, StartupResult } from '../types';
import { useEngine } from './hooks';
import { selectRunningAgentCount } from './store';
import type { FocusedPane } from './types';

export type AppProps = {
  engine: Engine;
  repository: string;
};

type PromptState = { type: 'none' } | { type: 'quit'; previousPane: FocusedPane };

export function App({ engine, repository }: AppProps) {
  const engineStore = useEngine({ engine, repository });
  const [startupResult, setStartupResult] = useState<StartupResult | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ type: 'none' });

  const focusedPane = useStore(engineStore, (s) => s.focusedPane);
  const shuttingDown = useStore(engineStore, (s) => s.shuttingDown);
  const runningAgentCount = useStore(engineStore, selectRunningAgentCount);
  const notifications = useStore(engineStore, (s) => s.notifications);
  const cycleFocus = useStore(engineStore, (s) => s.cycleFocus);
  const shutdown = useStore(engineStore, (s) => s.shutdown);

  const { exit } = useApp();

  const promptRef = useRef(prompt);
  promptRef.current = prompt;

  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;

  useEffect(() => {
    engine
      .start()
      .then((result) => {
        setStartupResult(result);
      })
      .catch((error) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });
  }, [engine]);

  useEffect(() => {
    if (!shuttingDown) return;
    if (runningAgentCount === 0) {
      exit();
    }
  }, [shuttingDown, runningAgentCount, exit]);

  useInput((input, key) => {
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

  if (startupError) {
    return (
      <Box flexDirection="column">
        <Text color="red">Startup failed: {startupError}</Text>
      </Box>
    );
  }

  if (shuttingDown) {
    return (
      <Box flexDirection="column">
        <Text>Shutting down... waiting for {runningAgentCount} agent(s)</Text>
      </Box>
    );
  }

  if (!startupResult) {
    return (
      <Box flexDirection="column">
        <Text>Starting engine...</Text>
      </Box>
    );
  }

  const startupNotification = buildStartupNotification(startupResult);

  return (
    <Box flexDirection="column" width="100%">
      {prompt.type === 'quit' && (
        <Box>
          <Text>
            {runningAgentCount > 0
              ? `Quit? ${runningAgentCount} agent(s) running. [y/n]`
              : 'Quit? [y/n]'}
          </Text>
        </Box>
      )}
      <Box flexDirection="row" width="100%">
        <Box
          flexGrow={1}
          flexBasis={0}
          borderStyle="single"
          borderColor={focusedPane === 'notifications' ? 'blue' : undefined}
          flexDirection="column"
        >
          <Text bold>Notifications</Text>
          {startupNotification && <Text>{startupNotification}</Text>}
          {notifications.map((n) => (
            <Text key={n.id}>{n.summary}</Text>
          ))}
        </Box>
        <Box
          flexGrow={1}
          flexBasis={0}
          borderStyle="single"
          borderColor={focusedPane === 'issueList' ? 'blue' : undefined}
          flexDirection="column"
        >
          <Text bold>Issue List</Text>
          <Text>No issues tracked</Text>
        </Box>
        <Box
          flexGrow={1}
          flexBasis={0}
          borderStyle="single"
          borderColor={focusedPane === 'detailPane' ? 'blue' : undefined}
          flexDirection="column"
        >
          <Text bold>Detail Pane</Text>
          <Text>No issue selected</Text>
        </Box>
      </Box>
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
