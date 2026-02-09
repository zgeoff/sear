import type { ReactNode } from 'react';
import { match, P } from 'ts-pattern';
import type { Notification } from '../types.ts';
import { List } from './list/list.tsx';
import type { ListItemData } from './list/types.ts';
import type { CopyToClipboard, NotificationsKeyState, OpenURL, SelectIndex } from './types.ts';

export interface NotificationsPaneProps {
  notifications: Notification[];
  focused: boolean;
  selectedIndex: number;
  paneWidth: number;
  paneHeight: number;
  viewportOffset: number;
  onViewportOffsetChange: (offset: number) => void;
  mouseScrolled: boolean;
  onMouseScrolledChange: (scrolled: boolean) => void;
}

export function NotificationsPane(props: NotificationsPaneProps): ReactNode {
  const items = buildListItems(props.notifications);

  return (
    <List
      label="notifications"
      items={items}
      selectedIndex={props.selectedIndex}
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

export interface HandleNotificationsInputParams {
  input: string;
  key: NotificationsKeyState;
  notifications: Notification[];
  selectedIndex: number;
  onSelectIndex: SelectIndex;
  openUrl: OpenURL;
  copyToClipboard: CopyToClipboard;
}

export function handleNotificationsInput(params: HandleNotificationsInputParams): void {
  const { input, key, notifications, selectedIndex, onSelectIndex, openUrl, copyToClipboard } =
    params;
  const reversed = [...notifications].reverse();
  if (reversed.length === 0) {
    return;
  }

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
      openUrl(selected.contextURL);
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

function buildListItems(notifications: Notification[]): ListItemData[] {
  if (notifications.length === 0) {
    return [{ key: 'empty', content: 'No notifications' }];
  }
  const reversed = [...notifications].reverse();
  return reversed.map((notification) => {
    const timestamp = formatTimestamp(notification.timestamp);
    const glyph = getIndicatorGlyph(notification);
    const body = renderContentString(notification);
    const logSuffix = getLogFilePath(notification) ? ' (logs)' : '';
    const copySuffix = notification.clipboardCommand ? ' [copy]' : '';
    const content = `${glyph} ${timestamp} ${body}${logSuffix}${copySuffix}`;

    return { key: notification.id, content };
  });
}

function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `[${hours}:${minutes}]`;
}

function getIndicatorGlyph(notification: Notification): string {
  return match(notification)
    .with({ eventType: 'dispatchReady' }, () => '\u25CF')
    .with({ eventType: 'agentStarted' }, () => '\u25B6')
    .with({ eventType: 'agentCompleted' }, () => '\u2713')
    .with({ eventType: 'agentFailed' }, () => '\u2717')
    .with({ eventType: 'agentSkipped' }, () => '\u2013')
    .with({ eventType: 'issueStatusChanged' }, () => '\u2192')
    .with({ eventType: 'specChanged' }, () => '~')
    .with({ eventType: 'recoveryPerformed' }, () => '\u21BB')
    .with({ eventType: 'notification', notificationType: 'approved' }, () => '\u2605')
    .with(
      { eventType: 'notification', notificationType: P.union('needs-refinement', 'blocked') },
      () => '\u2605',
    )
    .with({ eventType: 'notificationDismissed' }, () => '\u00D7')
    .with({ eventType: 'issueRemoved' }, () => '\u2212')
    .with({ eventType: 'startup' }, () => '\u2713')
    .exhaustive();
}

function renderContentString(notification: Notification): string {
  return match(notification)
    .with({ eventType: 'agentStarted', agentType: 'planner' }, (n) => {
      const specPart = 'specCount' in n ? `${n.specCount} specs` : 'specs';
      return `Planner started for ${specPart}`;
    })
    .with(
      { eventType: 'agentStarted' },
      (n) => `${formatAgentName(n.agentType)} started for #${n.issueNumber}`,
    )
    .with({ eventType: 'agentCompleted', agentType: 'planner' }, (n) => {
      const specPart = 'specCount' in n ? `${n.specCount} specs` : 'specs';
      return `Planner completed for ${specPart}`;
    })
    .with(
      { eventType: 'agentCompleted' },
      (n) => `${formatAgentName(n.agentType)} completed for #${n.issueNumber}`,
    )
    .with(
      { eventType: 'agentFailed', agentType: 'planner' },
      (n) => `Planner failed \u2014 ${n.error}`,
    )
    .with(
      { eventType: 'agentFailed' },
      (n) => `${formatAgentName(n.agentType)} failed for #${n.issueNumber} \u2014 ${n.error}`,
    )
    .with(
      { eventType: 'agentSkipped', agentType: 'planner' },
      () => 'Planner skipped \u2014 paths deferred',
    )
    .with(
      { eventType: 'agentSkipped' },
      (n) => `${formatAgentName(n.agentType)} skipped for #${n.issueNumber}`,
    )
    .with(
      { eventType: 'issueStatusChanged' },
      (n) => `#${n.issueNumber}: ${n.oldStatus ?? 'none'} \u2192 ${n.newStatus}`,
    )
    .with({ eventType: 'specChanged' }, (n) => `Spec changed: ${n.specFileName}`)
    .with({ eventType: 'recoveryPerformed' }, (n) => `#${n.issueNumber} recovered from stale`)
    .with(
      { eventType: 'notification', notificationType: 'approved' },
      (n) => `#${n.issueNumber} approved \u2014 ready to merge`,
    )
    .with(
      { eventType: 'notification', notificationType: P.union('needs-refinement', 'blocked') },
      (n) => {
        const label = n.notificationType === 'needs-refinement' ? 'needs refinement' : 'blocked';
        const guidance = n.resolutionGuidance ? ` \u2014 ${n.resolutionGuidance}` : '';
        return `#${n.issueNumber} ${label}${guidance}`;
      },
    )
    .with({ eventType: 'dispatchReady' }, (n) => `#${n.issueNumber} ready for dispatch`)
    .with({ eventType: 'notificationDismissed' }, (n) => `#${n.issueNumber} dismissed`)
    .with({ eventType: 'issueRemoved' }, (n) => `#${n.issueNumber} removed`)
    .with({ eventType: 'startup' }, (n) => {
      const base = `Startup complete: ${n.issueCount} issues tracked`;
      if (n.recoveriesPerformed > 0) {
        return `${base}, ${n.recoveriesPerformed} recoveries performed`;
      }
      return base;
    })
    .exhaustive();
}

function formatAgentName(agentType: 'implementor' | 'reviewer' | 'planner'): string {
  return match(agentType)
    .with('implementor', () => 'Implementor')
    .with('reviewer', () => 'Reviewer')
    .with('planner', () => 'Planner')
    .exhaustive();
}

function getLogFilePath(notification: Notification): string | undefined {
  if (notification.eventType === 'agentCompleted' || notification.eventType === 'agentFailed') {
    return notification.logFilePath;
  }
  return;
}
