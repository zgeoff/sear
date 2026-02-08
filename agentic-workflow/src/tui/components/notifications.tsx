import { Box, Text } from 'ink';
import type { Notification } from '../types';
import type { CopyToClipboard, NotificationsPaneProps, OpenURL } from './types';

export type { CopyToClipboard, NotificationsPaneProps, OpenURL };

export function NotificationsPane({
  notifications,
  focused,
  selectedIndex,
}: NotificationsPaneProps) {
  const reversed = [...notifications].reverse();

  return (
    <Box flexDirection="column">
      {reversed.length === 0 && <Text dimColor>No notifications</Text>}
      {reversed.map((notification, index) => {
        const isSelected = focused && index === selectedIndex;
        const timestamp = formatTimestamp(notification.timestamp);
        const indicator = getEventIndicator(notification.eventType);
        const copyIndicator = notification.clipboardCommand ? ' [copy]' : '';

        return (
          <Text key={notification.id} inverse={isSelected}>
            {timestamp} {indicator} {notification.summary}
            {copyIndicator}
          </Text>
        );
      })}
    </Box>
  );
}

export function handleNotificationsInput(
  input: string,
  key: { upArrow: boolean; downArrow: boolean; return: boolean },
  notifications: Notification[],
  selectedIndex: number,
  onSelectIndex: (index: number) => void,
  openURL: OpenURL,
  copyToClipboard: CopyToClipboard,
) {
  const reversed = [...notifications].reverse();
  if (reversed.length === 0) return;

  if (key.upArrow || input === 'k') {
    const newIndex = Math.max(0, selectedIndex - 1);
    onSelectIndex(newIndex);
    return;
  }

  if (key.downArrow || input === 'j') {
    const newIndex = Math.min(reversed.length - 1, selectedIndex + 1);
    onSelectIndex(newIndex);
    return;
  }

  if (key.return) {
    const selected = reversed[selectedIndex];
    if (selected?.contextURL) {
      openURL(selected.contextURL);
    }
    return;
  }

  if (input === 'c') {
    const selected = reversed[selectedIndex];
    if (selected?.clipboardCommand) {
      copyToClipboard(selected.clipboardCommand);
    }
  }
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function getEventIndicator(eventType: string): string {
  if (eventType === 'agentStarted') return '>>>';
  if (eventType === 'agentCompleted') return '[v]';
  if (eventType === 'agentFailed') return '[!]';
  if (eventType === 'agentSkipped') return '[-]';
  if (eventType === 'issueStatusChanged') return '<->';
  if (eventType === 'specChanged') return '[~]';
  if (eventType === 'notification') return '[*]';
  if (eventType === 'notificationDismissed') return '[x]';
  if (eventType === 'dispatchReady') return '[+]';
  if (eventType === 'recoveryPerformed') return '[r]';
  if (eventType === 'issueRemoved') return '[d]';
  return '---';
}
