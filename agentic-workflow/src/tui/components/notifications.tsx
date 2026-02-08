import { Box, Text } from 'ink';
import { match } from 'ts-pattern';
import type { Notification } from '../types';
import type {
  CopyToClipboard,
  NotificationsKeyState,
  NotificationsPaneProps,
  OpenURL,
  SelectIndex,
} from './types';

export function NotificationsPane(props: NotificationsPaneProps) {
  const reversed = [...props.notifications].reverse();

  return (
    <Box flexDirection="column">
      {reversed.length === 0 && <Text dimColor>No notifications</Text>}
      {reversed.map((notification, index) => {
        const isSelected = props.focused && index === props.selectedIndex;
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
  key: NotificationsKeyState,
  notifications: Notification[],
  selectedIndex: number,
  onSelectIndex: SelectIndex,
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
  return match(eventType)
    .with('agentStarted', () => '>>>')
    .with('agentCompleted', () => '[v]')
    .with('agentFailed', () => '[!]')
    .with('agentSkipped', () => '[-]')
    .with('issueStatusChanged', () => '<->')
    .with('specChanged', () => '[~]')
    .with('notification', () => '[*]')
    .with('notificationDismissed', () => '[x]')
    .with('dispatchReady', () => '[+]')
    .with('recoveryPerformed', () => '[r]')
    .with('issueRemoved', () => '[d]')
    .with('startup', () => '[v]')
    .otherwise(() => '---');
}
