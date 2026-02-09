import { Box, Text } from 'ink';
import Link from 'ink-link';
import { match, P } from 'ts-pattern';
import type { Notification } from '../types';
import type {
  CopyToClipboard,
  NotificationsKeyState,
  NotificationsPaneProps,
  OpenURL,
  SelectIndex,
} from './types';

type IndicatorResult = {
  glyph: string;
  color: string | undefined;
  dimColor: boolean;
};

type StatusStyle = {
  color: string | undefined;
  dimColor: boolean;
};

export function NotificationsPane(props: NotificationsPaneProps) {
  const reversed = [...props.notifications].reverse();

  return (
    <Box flexDirection="column">
      {reversed.length === 0 && <Text dimColor>No notifications</Text>}
      {reversed.map((notification, index) => {
        const isSelected = props.focused && index === props.selectedIndex;
        const timestamp = formatTimestamp(notification.timestamp);
        const indicator = getIndicator(notification);
        const copyIndicator = notification.clipboardCommand ? ' [copy]' : '';
        const logFilePath = getLogFilePath(notification);

        return (
          <Text key={notification.id} inverse={isSelected}>
            <Text
              {...(indicator.color ? { color: indicator.color } : {})}
              dimColor={indicator.dimColor}
            >
              {indicator.glyph}
            </Text>{' '}
            {timestamp} {renderContent(notification, props.repository.owner, props.repository.repo)}
            {logFilePath && (
              <>
                {' '}
                <Link url={`file://${logFilePath}`} fallback={false}>
                  <Text dimColor>(logs)</Text>
                </Link>
              </>
            )}
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
  return `[${hours}:${minutes}]`;
}

function getIndicator(notification: Notification): IndicatorResult {
  return match(notification)
    .with({ eventType: 'dispatchReady' }, () => ({
      glyph: '\u25CF',
      color: 'green',
      dimColor: false,
    }))
    .with({ eventType: 'agentStarted' }, () => ({
      glyph: '\u25B6',
      color: 'blue',
      dimColor: false,
    }))
    .with({ eventType: 'agentCompleted' }, () => ({
      glyph: '\u2713',
      color: 'green',
      dimColor: false,
    }))
    .with({ eventType: 'agentFailed' }, () => ({ glyph: '\u2717', color: 'red', dimColor: false }))
    .with({ eventType: 'agentSkipped' }, () => ({
      glyph: '\u2013',
      color: 'yellow',
      dimColor: false,
    }))
    .with({ eventType: 'issueStatusChanged' }, () => ({
      glyph: '\u2192',
      color: 'cyan',
      dimColor: false,
    }))
    .with({ eventType: 'specChanged' }, () => ({ glyph: '~', color: 'magenta', dimColor: false }))
    .with({ eventType: 'recoveryPerformed' }, () => ({
      glyph: '\u21BB',
      color: 'yellow',
      dimColor: false,
    }))
    .with({ eventType: 'notification', notificationType: 'approved' }, () => ({
      glyph: '\u2605',
      color: 'green',
      dimColor: false,
    }))
    .with(
      { eventType: 'notification', notificationType: P.union('needs-refinement', 'blocked') },
      () => ({ glyph: '\u2605', color: 'yellow', dimColor: false }),
    )
    .with({ eventType: 'notificationDismissed' }, () => ({
      glyph: '\u00D7',
      color: undefined,
      dimColor: true,
    }))
    .with({ eventType: 'issueRemoved' }, () => ({
      glyph: '\u2212',
      color: undefined,
      dimColor: true,
    }))
    .with({ eventType: 'startup' }, () => ({ glyph: '\u2713', color: 'green', dimColor: false }))
    .exhaustive();
}

function renderContent(notification: Notification, owner: string, repo: string): React.ReactNode {
  return match(notification)
    .with({ eventType: 'agentStarted', agentType: 'planner' }, (n) => (
      <>
        <Text bold color="cyan">
          Planner
        </Text>
        {' started for '}
        {n.specCount}
        {' specs'}
      </>
    ))
    .with({ eventType: 'agentStarted' }, (n) => (
      <>
        <Text bold color="cyan">
          {formatAgentName(n.agentType)}
        </Text>
        {' started for '}
        {renderIssueRef(n.issueNumber, owner, repo)}
      </>
    ))
    .with({ eventType: 'agentCompleted', agentType: 'planner' }, (n) => (
      <>
        <Text bold color="cyan">
          Planner
        </Text>
        {' completed for '}
        {n.specCount}
        {' specs'}
      </>
    ))
    .with({ eventType: 'agentCompleted' }, (n) => (
      <>
        <Text bold color="cyan">
          {formatAgentName(n.agentType)}
        </Text>
        {' completed for '}
        {renderIssueRef(n.issueNumber, owner, repo)}
      </>
    ))
    .with({ eventType: 'agentFailed', agentType: 'planner' }, (n) => (
      <>
        <Text bold color="cyan">
          Planner
        </Text>
        {' failed'}
        {' \u2014 '}
        <Text color="red">{n.error}</Text>
      </>
    ))
    .with({ eventType: 'agentFailed' }, (n) => (
      <>
        <Text bold color="cyan">
          {formatAgentName(n.agentType)}
        </Text>
        {' failed for '}
        {renderIssueRef(n.issueNumber, owner, repo)}
        {' \u2014 '}
        <Text color="red">{n.error}</Text>
      </>
    ))
    .with({ eventType: 'agentSkipped', agentType: 'planner' }, () => (
      <>
        <Text bold color="cyan">
          Planner
        </Text>
        {' skipped \u2014 paths deferred'}
      </>
    ))
    .with({ eventType: 'agentSkipped' }, (n) => (
      <>
        <Text bold color="cyan">
          {formatAgentName(n.agentType)}
        </Text>
        {' skipped for '}
        {renderIssueRef(n.issueNumber, owner, repo)}
      </>
    ))
    .with({ eventType: 'issueStatusChanged' }, (n) => {
      const oldStyle = getStatusStyle(n.oldStatus ?? 'none');
      const newStyle = getStatusStyle(n.newStatus);
      return (
        <>
          {renderIssueRef(n.issueNumber, owner, repo)}
          {': '}
          <Text {...(oldStyle.color ? { color: oldStyle.color } : {})} dimColor={oldStyle.dimColor}>
            {n.oldStatus ?? 'none'}
          </Text>
          {' \u2192 '}
          <Text {...(newStyle.color ? { color: newStyle.color } : {})} dimColor={newStyle.dimColor}>
            {n.newStatus}
          </Text>
        </>
      );
    })
    .with({ eventType: 'specChanged' }, (n) => (
      <>
        {'Spec changed: '}
        <Link url={n.contextURL ?? ''} fallback={false}>
          <Text color="magenta">{n.specFileName}</Text>
        </Link>
      </>
    ))
    .with({ eventType: 'recoveryPerformed' }, (n) => (
      <>
        {renderIssueRef(n.issueNumber, owner, repo)}
        {' recovered from stale'}
      </>
    ))
    .with({ eventType: 'notification', notificationType: 'approved' }, (n) => (
      <>
        {renderIssueRef(n.issueNumber, owner, repo)}
        {' approved \u2014 ready to merge'}
      </>
    ))
    .with(
      { eventType: 'notification', notificationType: P.union('needs-refinement', 'blocked') },
      (n) => (
        <>
          {renderIssueRef(n.issueNumber, owner, repo)}
          {n.notificationType === 'needs-refinement' ? ' needs refinement' : ' blocked'}
          {n.resolutionGuidance ? ` \u2014 ${n.resolutionGuidance}` : ''}
        </>
      ),
    )
    .with({ eventType: 'dispatchReady' }, (n) => (
      <>
        {renderIssueRef(n.issueNumber, owner, repo)}
        {' ready for dispatch'}
      </>
    ))
    .with({ eventType: 'notificationDismissed' }, (n) => (
      <>
        {renderIssueRef(n.issueNumber, owner, repo)}
        {' dismissed'}
      </>
    ))
    .with({ eventType: 'issueRemoved' }, (n) => (
      <>
        {renderIssueRef(n.issueNumber, owner, repo)}
        {' removed'}
      </>
    ))
    .with({ eventType: 'startup' }, (n) => {
      const base = `Startup complete: ${n.issueCount} issues tracked`;
      if (n.recoveriesPerformed > 0) {
        return (
          <>
            {base}, {n.recoveriesPerformed} recoveries performed
          </>
        );
      }
      return <>{base}</>;
    })
    .exhaustive();
}

function renderIssueRef(
  issueNumber: number | undefined,
  owner: string,
  repo: string,
): React.ReactNode {
  if (issueNumber === undefined) return null;
  const url = `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
  return (
    <Link url={url} fallback={false}>
      <Text bold>#{issueNumber}</Text>
    </Link>
  );
}

function formatAgentName(agentType: 'implementor' | 'reviewer' | 'planner'): string {
  return match(agentType)
    .with('implementor', () => 'Implementor')
    .with('reviewer', () => 'Reviewer')
    .with('planner', () => 'Planner')
    .exhaustive();
}

function getStatusStyle(status: string): StatusStyle {
  return match(status)
    .with('in-progress', () => ({ color: 'blue', dimColor: false }))
    .with('review', () => ({ color: 'cyan', dimColor: false }))
    .with('needs-refinement', () => ({ color: 'yellow', dimColor: false }))
    .with('blocked', () => ({ color: 'yellow', dimColor: false }))
    .with('approved', () => ({ color: 'green', dimColor: false }))
    .with('none', () => ({ color: undefined, dimColor: true }))
    .otherwise(() => ({ color: undefined, dimColor: false }));
}

function getLogFilePath(notification: Notification): string | undefined {
  if (notification.eventType === 'agentCompleted' || notification.eventType === 'agentFailed') {
    return notification.logFilePath;
  }
  return undefined;
}
