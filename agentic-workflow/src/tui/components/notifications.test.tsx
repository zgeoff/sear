import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { match } from 'ts-pattern';
import { expect, test, vi } from 'vitest';
import type { IssueStatusChangedNotification, Notification } from '../types';
import { handleNotificationsInput, NotificationsPane } from './notifications';
import type { NotificationsPaneProps } from './types';

type PartialKeyState = { upArrow?: boolean; downArrow?: boolean; return?: boolean };

function buildNotification(overrides?: Partial<IssueStatusChangedNotification>): Notification {
  return {
    id: 'notif-1',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'issueStatusChanged',
    issueNumber: 1,
    oldStatus: 'pending',
    newStatus: 'in-progress',
    summary: '#1: pending → in-progress',
    ...overrides,
  };
}

function setupRenderTest(overrides?: Partial<NotificationsPaneProps>) {
  const props: NotificationsPaneProps = {
    notifications: [],
    focused: false,
    selectedIndex: 0,
    ...overrides,
  };

  const instance = render(
    <Box flexDirection="column">
      <NotificationsPane {...props} />
    </Box>,
  );

  return instance;
}

function setupInputTest(notifications: Notification[], selectedIndex: number) {
  const openURL = vi.fn();
  const copyToClipboard = vi.fn();
  const onSelectIndex = vi.fn();

  function sendInput(input: string, key: PartialKeyState) {
    handleNotificationsInput(
      input,
      {
        upArrow: key.upArrow ?? false,
        downArrow: key.downArrow ?? false,
        return: key.return ?? false,
      },
      notifications,
      selectedIndex,
      onSelectIndex,
      openURL,
      copyToClipboard,
    );
  }

  return { sendInput, openURL, copyToClipboard, onSelectIndex };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test('it shows an empty state message when there are no notifications', () => {
  const { lastFrame } = setupRenderTest({ notifications: [] });

  expect(lastFrame()).toContain('No notifications');
});

test('it displays notifications with timestamps and event indicators', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      timestamp: '2026-02-08T10:30:45.000Z',
      summary: '#1: pending → in-progress',
    }),
  ];

  const { lastFrame } = setupRenderTest({ notifications });

  const frame = lastFrame();
  expect(frame).toContain('<->');
  expect(frame).toContain('#1: pending → in-progress');
});

test('it shows newest notifications at the top of the list', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      timestamp: '2026-02-08T10:00:00.000Z',
      summary: 'First event',
    }),
    buildNotification({
      id: 'notif-2',
      timestamp: '2026-02-08T10:01:00.000Z',
      summary: 'Second event',
    }),
    buildNotification({
      id: 'notif-3',
      timestamp: '2026-02-08T10:02:00.000Z',
      summary: 'Third event',
    }),
  ];

  const { lastFrame } = setupRenderTest({ notifications });

  const frame = lastFrame() ?? '';
  const thirdPos = frame.indexOf('Third event');
  const secondPos = frame.indexOf('Second event');
  const firstPos = frame.indexOf('First event');

  expect(thirdPos).toBeLessThan(secondPos);
  expect(secondPos).toBeLessThan(firstPos);
});

test('it shows a copy indicator for notifications with a clipboard command', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      clipboardCommand: 'claude -p "fix the spec"',
      summary: '#3 needs refinement',
    }),
  ];

  const { lastFrame } = setupRenderTest({ notifications });

  expect(lastFrame()).toContain('[copy]');
});

test('it does not show a copy indicator for notifications without a clipboard command', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      summary: '#1: pending → in-progress',
    }),
  ];

  const { lastFrame } = setupRenderTest({ notifications });

  expect(lastFrame()).not.toContain('[copy]');
});

test('it shows the correct indicator for each event type', () => {
  const types: Array<{ eventType: Notification['eventType']; indicator: string }> = [
    { eventType: 'agentStarted', indicator: '>>>' },
    { eventType: 'agentCompleted', indicator: '[v]' },
    { eventType: 'agentFailed', indicator: '[!]' },
    { eventType: 'agentSkipped', indicator: '[-]' },
    { eventType: 'issueStatusChanged', indicator: '<->' },
    { eventType: 'specChanged', indicator: '[~]' },
    { eventType: 'notification', indicator: '[*]' },
    { eventType: 'notificationDismissed', indicator: '[x]' },
    { eventType: 'dispatchReady', indicator: '[+]' },
    { eventType: 'recoveryPerformed', indicator: '[r]' },
    { eventType: 'issueRemoved', indicator: '[d]' },
    { eventType: 'startup', indicator: '[v]' },
  ];

  for (const { eventType, indicator } of types) {
    const notification = buildTypedNotification(eventType, `notif-${eventType}`);

    const { lastFrame } = setupRenderTest({ notifications: [notification] });

    expect(lastFrame()).toContain(indicator);
  }
});

// ---------------------------------------------------------------------------
// Log file path suffix
// ---------------------------------------------------------------------------

test('it shows a logs suffix for a completed agent notification with a log file path', () => {
  const notification = buildTypedNotification('agentCompleted', 'notif-logs');
  const notifWithLog = { ...notification, logFilePath: '/logs/session.log' };

  const { lastFrame } = setupRenderTest({ notifications: [notifWithLog] });

  expect(lastFrame()).toContain('(logs)');
});

test('it does not show a logs suffix for a completed agent notification without a log file path', () => {
  const notification = buildTypedNotification('agentCompleted', 'notif-no-logs');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).not.toContain('(logs)');
});

test('it shows a logs suffix for a failed agent notification with a log file path', () => {
  const notification = buildTypedNotification('agentFailed', 'notif-fail-logs');
  const notifWithLog = { ...notification, logFilePath: '/logs/fail-session.log' };

  const { lastFrame } = setupRenderTest({ notifications: [notifWithLog] });

  expect(lastFrame()).toContain('(logs)');
});

test('it does not show a logs suffix for a failed agent notification without a log file path', () => {
  const notification = buildTypedNotification('agentFailed', 'notif-fail-no-logs');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).not.toContain('(logs)');
});

test('it does not show a logs suffix for non-agent notification types', () => {
  const notification = buildTypedNotification('issueStatusChanged', 'notif-status');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).not.toContain('(logs)');
});

// ---------------------------------------------------------------------------
// Keyboard navigation (handleNotificationsInput)
// ---------------------------------------------------------------------------

test('it moves the selection down when the down arrow is pressed', () => {
  const notifications = [
    buildNotification({ id: 'notif-1' }),
    buildNotification({ id: 'notif-2' }),
    buildNotification({ id: 'notif-3' }),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 0);

  sendInput('', { downArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it moves the selection down when j is pressed', () => {
  const notifications = [
    buildNotification({ id: 'notif-1' }),
    buildNotification({ id: 'notif-2' }),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 0);

  sendInput('j', {});

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it moves the selection up when the up arrow is pressed', () => {
  const notifications = [
    buildNotification({ id: 'notif-1' }),
    buildNotification({ id: 'notif-2' }),
    buildNotification({ id: 'notif-3' }),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 2);

  sendInput('', { upArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it moves the selection up when k is pressed', () => {
  const notifications = [
    buildNotification({ id: 'notif-1' }),
    buildNotification({ id: 'notif-2' }),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 1);

  sendInput('k', {});

  expect(onSelectIndex).toHaveBeenCalledWith(0);
});

test('it does not move the selection above the first item', () => {
  const notifications = [
    buildNotification({ id: 'notif-1' }),
    buildNotification({ id: 'notif-2' }),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 0);

  sendInput('', { upArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(0);
});

test('it does not move the selection below the last item', () => {
  const notifications = [
    buildNotification({ id: 'notif-1' }),
    buildNotification({ id: 'notif-2' }),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 1);

  sendInput('', { downArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it does nothing when navigating with an empty notification list', () => {
  const { sendInput, onSelectIndex } = setupInputTest([], 0);

  sendInput('j', {});

  expect(onSelectIndex).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Enter — open context in browser
// ---------------------------------------------------------------------------

test('it opens the context URL when Enter is pressed on a notification with a URL', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      contextURL: 'https://github.com/owner/repo/issues/5',
    }),
    buildNotification({
      id: 'notif-2',
      contextURL: 'https://github.com/owner/repo/commit/abc123',
    }),
  ];

  // selectedIndex 0 in the reversed list = notif-2 (newest)
  const { sendInput, openURL } = setupInputTest(notifications, 0);

  sendInput('', { return: true });

  expect(openURL).toHaveBeenCalledWith('https://github.com/owner/repo/commit/abc123');
});

test('it does not open anything when Enter is pressed on a notification without a URL', () => {
  const notifications = [buildNotification({ id: 'notif-1' })];

  const { sendInput, openURL } = setupInputTest(notifications, 0);

  sendInput('', { return: true });

  expect(openURL).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// c — copy clipboard command
// ---------------------------------------------------------------------------

test('it copies the clipboard command when c is pressed on a notification with one', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      clipboardCommand: 'claude -p "fix the spec"',
    }),
  ];

  // reversed list: notif-1 is at index 0
  const { sendInput, copyToClipboard } = setupInputTest(notifications, 0);

  sendInput('c', {});

  expect(copyToClipboard).toHaveBeenCalledWith('claude -p "fix the spec"');
});

test('it does nothing when c is pressed on a notification without a clipboard command', () => {
  const notifications = [buildNotification({ id: 'notif-1' })];

  const { sendInput, copyToClipboard } = setupInputTest(notifications, 0);

  sendInput('c', {});

  expect(copyToClipboard).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Selection indexing with reversed list
// ---------------------------------------------------------------------------

test('it opens the correct URL when selecting a specific notification in reversed order', () => {
  const notifications = [
    buildNotification({
      id: 'notif-1',
      contextURL: 'https://github.com/owner/repo/issues/1',
      summary: 'First',
    }),
    buildNotification({
      id: 'notif-2',
      contextURL: 'https://github.com/owner/repo/issues/2',
      summary: 'Second',
    }),
    buildNotification({
      id: 'notif-3',
      contextURL: 'https://github.com/owner/repo/issues/3',
      summary: 'Third',
    }),
  ];

  // reversed: [notif-3, notif-2, notif-1]
  // index 1 = notif-2
  const { sendInput, openURL } = setupInputTest(notifications, 1);

  sendInput('', { return: true });

  expect(openURL).toHaveBeenCalledWith('https://github.com/owner/repo/issues/2');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTypedNotification(eventType: Notification['eventType'], id: string): Notification {
  const base = {
    id,
    timestamp: '2026-02-08T10:30:45.000Z',
    summary: `Test ${eventType}`,
  };

  return match(eventType)
    .with('agentStarted', (t) => ({
      ...base,
      eventType: t,
      agentType: 'implementor' as const,
      issueNumber: 1,
    }))
    .with('agentCompleted', (t) => ({
      ...base,
      eventType: t,
      agentType: 'implementor' as const,
      issueNumber: 1,
    }))
    .with('agentFailed', (t) => ({
      ...base,
      eventType: t,
      agentType: 'implementor' as const,
      issueNumber: 1,
      error: 'err',
      sessionID: 'sess-1',
    }))
    .with('agentSkipped', (t) => ({
      ...base,
      eventType: t,
      agentType: 'implementor' as const,
      issueNumber: 1,
    }))
    .with('issueStatusChanged', (t) => ({
      ...base,
      eventType: t,
      issueNumber: 1,
      oldStatus: 'pending',
      newStatus: 'in-progress',
    }))
    .with('specChanged', (t) => ({ ...base, eventType: t, specFileName: 'test.md' }))
    .with('recoveryPerformed', (t) => ({ ...base, eventType: t, issueNumber: 1 }))
    .with('dispatchReady', (t) => ({ ...base, eventType: t, issueNumber: 1 }))
    .with('notification', (t) => ({
      ...base,
      eventType: t,
      issueNumber: 1,
      notificationType: 'approved' as const,
    }))
    .with('notificationDismissed', (t) => ({ ...base, eventType: t, issueNumber: 1 }))
    .with('issueRemoved', (t) => ({ ...base, eventType: t, issueNumber: 1 }))
    .with('startup', (t) => ({ ...base, eventType: t, issueCount: 5, recoveriesPerformed: 0 }))
    .exhaustive();
}
