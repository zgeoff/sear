import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { match } from 'ts-pattern';
import { expect, test, vi } from 'vitest';
import type { Notification } from '../types.ts';
import {
  getIndicatorColor,
  getStatusStyle,
  handleNotificationsInput,
  isIndicatorDim,
  NotificationsPane,
  type NotificationsPaneProps,
} from './notifications.tsx';

const TIMESTAMP_PATTERN = /\[\d{2}:\d{2}\]/;
const TIMESTAMP_WITH_SECONDS_PATTERN = /\[\d{2}:\d{2}:\d{2}\]/;

interface PartialKeyState {
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
}

function setupRenderTest(overrides?: Partial<NotificationsPaneProps>): ReturnType<typeof render> {
  const props: NotificationsPaneProps = {
    notifications: [],
    repository: 'test-owner/test-repo',
    focused: false,
    selectedIndex: 0,
    paneWidth: 80,
    paneHeight: 20,
    viewportOffset: 0,
    onViewportOffsetChange: vi.fn(),
    mouseScrolled: false,
    onMouseScrolledChange: vi.fn(),
    ...overrides,
  };

  const instance = render(
    <Box flexDirection="column">
      <NotificationsPane {...props} />
    </Box>,
  );

  return instance;
}

function setupInputTest(
  notifications: Notification[],
  selectedIndex: number,
): {
  sendInput: (input: string, key: PartialKeyState) => void;
  openURL: ReturnType<typeof vi.fn>;
  copyToClipboard: ReturnType<typeof vi.fn>;
  onSelectIndex: ReturnType<typeof vi.fn>;
} {
  const openUrl = vi.fn();
  const copyToClipboard = vi.fn();
  const onSelectIndex = vi.fn();

  function sendInput(input: string, key: PartialKeyState): void {
    handleNotificationsInput({
      input,
      key: {
        upArrow: key.upArrow ?? false,
        downArrow: key.downArrow ?? false,
        return: key.return ?? false,
      },
      notifications,
      selectedIndex,
      onSelectIndex,
      openUrl,
      copyToClipboard,
    });
  }

  return { sendInput, openURL: openUrl, copyToClipboard, onSelectIndex };
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

test('it does not render its own header label since the dashboard border owns it', () => {
  const { lastFrame } = setupRenderTest({ notifications: [] });

  const frame = lastFrame() ?? '';
  expect(frame).not.toContain('NOTIFICATIONS');
});

test('it renders the correct Unicode glyph for each notification type', () => {
  const glyphMap: Array<{ eventType: Notification['eventType']; glyph: string }> = [
    { eventType: 'dispatchReady', glyph: '\u25CF' },
    { eventType: 'agentStarted', glyph: '\u25B6' },
    { eventType: 'agentCompleted', glyph: '\u2713' },
    { eventType: 'agentFailed', glyph: '\u2717' },
    { eventType: 'agentSkipped', glyph: '\u2013' },
    { eventType: 'issueStatusChanged', glyph: '\u2192' },
    { eventType: 'specChanged', glyph: '~' },
    { eventType: 'recoveryPerformed', glyph: '\u21BB' },
    { eventType: 'issueRefined', glyph: '\u00D7' },
    { eventType: 'issueUnblocked', glyph: '\u00D7' },
    { eventType: 'prUnapproved', glyph: '\u00D7' },
    { eventType: 'ciCheckFailed', glyph: '!' },
    { eventType: 'ciCheckRecovered', glyph: '\u00D7' },
    { eventType: 'issueRemoved', glyph: '\u2212' },
    { eventType: 'startup', glyph: '\u2713' },
  ];

  for (const { eventType, glyph } of glyphMap) {
    const notification = buildTypedNotification(eventType, `notif-${eventType}`);

    const { lastFrame } = setupRenderTest({ notifications: [notification] });

    expect(lastFrame()).toContain(glyph);
  }
});

test('it renders a green star indicator for an approved notification', () => {
  const notification = buildTypedNotification('prApproved', 'notif-approved');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).toContain('\u2605');
});

test('it renders a yellow star indicator for a needs-refinement notification', () => {
  const notification = buildTypedNotification('issueNeedsRefinement', 'notif-nr', {
    resolutionGuidance: 'fix the spec',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).toContain('\u2605');
});

test('it renders a yellow star indicator for a blocked notification', () => {
  const notification = buildTypedNotification('issueBlocked', 'notif-blocked', {
    resolutionGuidance: 'waiting on dependency',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).toContain('\u2605');
});

// ---------------------------------------------------------------------------
// Indicator colors (getIndicatorColor)
// ---------------------------------------------------------------------------

test('it returns green for a dispatch-ready indicator', () => {
  const notification = buildTypedNotification('dispatchReady', 'n-1');
  expect(getIndicatorColor(notification)).toBe('green');
});

test('it returns blue for an agent-started indicator', () => {
  const notification = buildTypedNotification('agentStarted', 'n-1');
  expect(getIndicatorColor(notification)).toBe('blue');
});

test('it returns green for an agent-completed indicator', () => {
  const notification = buildTypedNotification('agentCompleted', 'n-1');
  expect(getIndicatorColor(notification)).toBe('green');
});

test('it returns red for an agent-failed indicator', () => {
  const notification = buildTypedNotification('agentFailed', 'n-1');
  expect(getIndicatorColor(notification)).toBe('red');
});

test('it returns yellow for an agent-skipped indicator', () => {
  const notification = buildTypedNotification('agentSkipped', 'n-1');
  expect(getIndicatorColor(notification)).toBe('yellow');
});

test('it returns cyan for a status-changed indicator', () => {
  const notification = buildTypedNotification('issueStatusChanged', 'n-1');
  expect(getIndicatorColor(notification)).toBe('cyan');
});

test('it returns magenta for a spec-changed indicator', () => {
  const notification = buildTypedNotification('specChanged', 'n-1');
  expect(getIndicatorColor(notification)).toBe('magenta');
});

test('it returns yellow for a recovery-performed indicator', () => {
  const notification = buildTypedNotification('recoveryPerformed', 'n-1');
  expect(getIndicatorColor(notification)).toBe('yellow');
});

test('it returns green for an approved notification indicator', () => {
  const notification = buildTypedNotification('prApproved', 'n-1');
  expect(getIndicatorColor(notification)).toBe('green');
});

test('it returns yellow for a needs-refinement notification indicator', () => {
  const notification = buildTypedNotification('issueNeedsRefinement', 'n-1', {
    resolutionGuidance: 'fix it',
  });
  expect(getIndicatorColor(notification)).toBe('yellow');
});

test('it returns yellow for a blocked notification indicator', () => {
  const notification = buildTypedNotification('issueBlocked', 'n-1', {
    resolutionGuidance: 'waiting',
  });
  expect(getIndicatorColor(notification)).toBe('yellow');
});

test('it returns undefined for an issue-refined indicator', () => {
  const notification = buildTypedNotification('issueRefined', 'n-1');
  expect(getIndicatorColor(notification)).toBeUndefined();
});

test('it returns red for a CI check failed indicator', () => {
  const notification = buildTypedNotification('ciCheckFailed', 'n-1');
  expect(getIndicatorColor(notification)).toBe('red');
});

test('it returns undefined for a CI check recovered indicator', () => {
  const notification = buildTypedNotification('ciCheckRecovered', 'n-1');
  expect(getIndicatorColor(notification)).toBeUndefined();
});

test('it returns undefined for an issue-removed indicator', () => {
  const notification = buildTypedNotification('issueRemoved', 'n-1');
  expect(getIndicatorColor(notification)).toBeUndefined();
});

test('it returns green for a startup indicator', () => {
  const notification = buildTypedNotification('startup', 'n-1');
  expect(getIndicatorColor(notification)).toBe('green');
});

// ---------------------------------------------------------------------------
// Indicator dimming (isIndicatorDim)
// ---------------------------------------------------------------------------

test('it dims the indicator for an issue-refined notification', () => {
  const notification = buildTypedNotification('issueRefined', 'n-1');
  expect(isIndicatorDim(notification)).toBe(true);
});

test('it dims the indicator for an issue-unblocked notification', () => {
  const notification = buildTypedNotification('issueUnblocked', 'n-1');
  expect(isIndicatorDim(notification)).toBe(true);
});

test('it dims the indicator for a PR unapproved notification', () => {
  const notification = buildTypedNotification('prUnapproved', 'n-1');
  expect(isIndicatorDim(notification)).toBe(true);
});

test('it dims the indicator for a CI check recovered notification', () => {
  const notification = buildTypedNotification('ciCheckRecovered', 'n-1');
  expect(isIndicatorDim(notification)).toBe(true);
});

test('it dims the indicator for a removed issue notification', () => {
  const notification = buildTypedNotification('issueRemoved', 'n-1');
  expect(isIndicatorDim(notification)).toBe(true);
});

test('it does not dim the indicator for a dispatch-ready notification', () => {
  const notification = buildTypedNotification('dispatchReady', 'n-1');
  expect(isIndicatorDim(notification)).toBe(false);
});

test('it does not dim the indicator for an agent-started notification', () => {
  const notification = buildTypedNotification('agentStarted', 'n-1');
  expect(isIndicatorDim(notification)).toBe(false);
});

test('it does not dim the indicator for a startup notification', () => {
  const notification = buildTypedNotification('startup', 'n-1');
  expect(isIndicatorDim(notification)).toBe(false);
});

// ---------------------------------------------------------------------------
// Status label styling (getStatusStyle)
// ---------------------------------------------------------------------------

test('it returns default style for a pending status label', () => {
  expect(getStatusStyle('pending')).toStrictEqual({ color: undefined, dimColor: false });
});

test('it returns default style for an unblocked status label', () => {
  expect(getStatusStyle('unblocked')).toStrictEqual({ color: undefined, dimColor: false });
});

test('it returns default style for a needs-changes status label', () => {
  expect(getStatusStyle('needs-changes')).toStrictEqual({ color: undefined, dimColor: false });
});

test('it returns blue for an in-progress status label', () => {
  expect(getStatusStyle('in-progress')).toStrictEqual({ color: 'blue', dimColor: false });
});

test('it returns cyan for a review status label', () => {
  expect(getStatusStyle('review')).toStrictEqual({ color: 'cyan', dimColor: false });
});

test('it returns yellow for a needs-refinement status label', () => {
  expect(getStatusStyle('needs-refinement')).toStrictEqual({ color: 'yellow', dimColor: false });
});

test('it returns yellow for a blocked status label', () => {
  expect(getStatusStyle('blocked')).toStrictEqual({ color: 'yellow', dimColor: false });
});

test('it returns green for an approved status label', () => {
  expect(getStatusStyle('approved')).toStrictEqual({ color: 'green', dimColor: false });
});

test('it returns dim style for the none status representing first detection', () => {
  expect(getStatusStyle('none')).toStrictEqual({ color: undefined, dimColor: true });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test('it formats timestamps in bracketed hours and minutes without seconds', () => {
  const notification = buildTypedNotification('issueStatusChanged', 'notif-ts');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  // The timestamp 2026-02-08T10:30:45.000Z in local time should show [HH:MM]
  // We check for the bracket format pattern
  expect(frame).toMatch(TIMESTAMP_PATTERN);
  // Ensure no seconds are present (no third colon group inside brackets)
  expect(frame).not.toMatch(TIMESTAMP_WITH_SECONDS_PATTERN);
});

// ---------------------------------------------------------------------------
// Semantic content rendering
// ---------------------------------------------------------------------------

test('it renders agent names in the notification content for started events', () => {
  const notification = buildTypedNotification('agentStarted', 'notif-started', {
    agentType: 'implementor',
    issueNumber: 42,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Implementor');
  expect(frame).toContain('started for');
  expect(frame).toContain('#42');
});

test('it renders planner started with spec count instead of issue reference', () => {
  const notification = buildTypedNotification('agentStarted', 'notif-planner-start', {
    agentType: 'planner',
    specCount: 3,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Planner');
  expect(frame).toContain('started for');
  expect(frame).toContain('3');
  expect(frame).toContain('specs');
});

test('it renders agent completed with issue reference for task agents', () => {
  const notification = buildTypedNotification('agentCompleted', 'notif-completed', {
    agentType: 'reviewer',
    issueNumber: 7,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Reviewer');
  expect(frame).toContain('completed for');
  expect(frame).toContain('#7');
});

test('it renders planner completed with spec count', () => {
  const notification = buildTypedNotification('agentCompleted', 'notif-planner-done', {
    agentType: 'planner',
    specCount: 5,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Planner');
  expect(frame).toContain('completed for');
  expect(frame).toContain('5');
  expect(frame).toContain('specs');
});

test('it renders agent failed with error message for task agents', () => {
  const notification = buildTypedNotification('agentFailed', 'notif-failed', {
    agentType: 'implementor',
    issueNumber: 10,
    error: 'timeout exceeded',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Implementor');
  expect(frame).toContain('failed for');
  expect(frame).toContain('#10');
  expect(frame).toContain('timeout exceeded');
});

test('it renders planner failed with error message and no issue reference', () => {
  const notification = buildTypedNotification('agentFailed', 'notif-planner-fail', {
    agentType: 'planner',
    error: 'rate limit hit',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Planner');
  expect(frame).toContain('failed');
  expect(frame).toContain('rate limit hit');
  expect(frame).not.toContain('#');
});

test('it renders agent skipped with issue reference for task agents', () => {
  const notification = buildTypedNotification('agentSkipped', 'notif-skipped', {
    agentType: 'reviewer',
    issueNumber: 15,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Reviewer');
  expect(frame).toContain('skipped for');
  expect(frame).toContain('#15');
});

test('it renders planner skipped with paths deferred message', () => {
  const notification = buildTypedNotification('agentSkipped', 'notif-planner-skip', {
    agentType: 'planner',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Planner');
  expect(frame).toContain('skipped');
  expect(frame).toContain('paths deferred');
});

test('it renders status change with old and new status labels', () => {
  const notification: Notification = {
    id: 'notif-status',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'issueStatusChanged',
    issueNumber: 3,
    oldStatus: 'pending',
    newStatus: 'in-progress',
    summary: '#3: pending -> in-progress',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#3');
  expect(frame).toContain('pending');
  expect(frame).toContain('\u2192');
  expect(frame).toContain('in-progress');
});

test('it renders first detection status with none as the old status', () => {
  const notification: Notification = {
    id: 'notif-first-detect',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'issueStatusChanged',
    issueNumber: 5,
    oldStatus: null,
    newStatus: 'pending',
    summary: '#5: none -> pending',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('none');
  expect(frame).toContain('pending');
});

test('it renders spec changed with the filename', () => {
  const notification: Notification = {
    id: 'notif-spec',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'specChanged',
    specFileName: 'control-plane.md',
    summary: 'Spec changed: control-plane.md',
    contextURL: 'https://github.com/test-owner/test-repo/commit/abc123',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Spec changed:');
  expect(frame).toContain('control-plane.md');
});

test('it renders recovery performed with issue reference', () => {
  const notification = buildTypedNotification('recoveryPerformed', 'notif-recovery');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('recovered from stale');
});

test('it renders dispatch ready with issue reference', () => {
  const notification = buildTypedNotification('dispatchReady', 'notif-dispatch');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('ready for dispatch');
});

test('it renders approved notification with ready to merge message', () => {
  const notification = buildTypedNotification('prApproved', 'notif-approved');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('approved');
  expect(frame).toContain('ready to merge');
});

test('it renders needs-refinement notification with resolution guidance', () => {
  const notification = buildTypedNotification('issueNeedsRefinement', 'notif-nr', {
    resolutionGuidance: 'ambiguous acceptance criteria',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('needs refinement');
  expect(frame).toContain('ambiguous acceptance criteria');
});

test('it renders blocked notification with resolution guidance', () => {
  const notification = buildTypedNotification('issueBlocked', 'notif-blocked', {
    resolutionGuidance: 'waiting on external API',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('blocked');
  expect(frame).toContain('waiting on external API');
});

test('it renders issue refined with issue reference', () => {
  const notification = buildTypedNotification('issueRefined', 'notif-refined');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('refined');
});

test('it renders issue removed with issue reference', () => {
  const notification = buildTypedNotification('issueRemoved', 'notif-removed');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#1');
  expect(frame).toContain('removed');
});

test('it renders startup with issue count and no recoveries when zero', () => {
  const notification: Notification = {
    id: 'notif-startup',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'startup',
    issueCount: 5,
    recoveriesPerformed: 0,
    summary: 'Startup complete: 5 issues tracked',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Startup complete: 5 issues tracked');
  expect(frame).not.toContain('recoveries');
});

test('it renders startup with issue count and recoveries when non-zero', () => {
  const notification: Notification = {
    id: 'notif-startup-recovery',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'startup',
    issueCount: 8,
    recoveriesPerformed: 2,
    summary: 'Startup complete: 8 issues tracked, 2 recoveries performed',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('Startup complete: 8 issues tracked');
  expect(frame).toContain('2 recoveries performed');
});

// ---------------------------------------------------------------------------
// CI notifications
// ---------------------------------------------------------------------------

test('it renders CI check failed with PR number', () => {
  const notification = buildTypedNotification('ciCheckFailed', 'notif-ci-fail', {
    issueNumber: 5,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('CI failed on PR #10');
});

test('it renders CI check failed with resolution guidance when present', () => {
  const notification: Notification = {
    id: 'notif-ci-fail-guidance',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'ciCheckFailed',
    issueNumber: 7,
    prNumber: 15,
    resolutionGuidance: 'Fix lint errors',
    summary: 'CI failed on PR #15 — Fix lint errors',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('CI failed on PR #15');
  expect(frame).toContain('Fix lint errors');
});

test('it renders CI check recovered with issue reference', () => {
  const notification = buildTypedNotification('ciCheckRecovered', 'notif-ci-recover', {
    issueNumber: 3,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('#3');
  expect(frame).toContain('CI recovered for');
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
// Terminal hyperlinks (OSC 8)
// ---------------------------------------------------------------------------

test('it renders issue references as terminal hyperlinks to the issue URL', () => {
  const notification = buildTypedNotification('dispatchReady', 'notif-link', {
    issueNumber: 42,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  // OSC 8 hyperlink format: \x1b]8;;<url>\x07<text>\x1b]8;;\x07
  expect(frame).toContain(
    // biome-ignore lint/security/noSecrets: OSC 8 escape sequence test fixture
    '\x1b]8;;https://github.com/test-owner/test-repo/issues/42\x07#42\x1b]8;;\x07',
  );
});

test('it renders issue references with the correct repository in the URL', () => {
  const notification = buildTypedNotification('recoveryPerformed', 'notif-repo-link', {
    issueNumber: 7,
  });

  const { lastFrame } = setupRenderTest({
    notifications: [notification],
    repository: 'acme/widgets',
  });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('\x1b]8;;https://github.com/acme/widgets/issues/7\x07#7\x1b]8;;\x07');
});

test('it renders spec filenames as terminal hyperlinks to the commit diff URL', () => {
  const notification: Notification = {
    id: 'notif-spec-link',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'specChanged',
    specFileName: 'control-plane.md',
    summary: 'Spec changed: control-plane.md',
    contextURL: 'https://github.com/test-owner/test-repo/commit/abc123',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain(
    // biome-ignore lint/security/noSecrets: OSC 8 escape sequence test fixture
    '\x1b]8;;https://github.com/test-owner/test-repo/commit/abc123\x07control-plane.md\x1b]8;;\x07',
  );
});

test('it renders spec filenames without a hyperlink when no context URL is present', () => {
  const notification: Notification = {
    id: 'notif-spec-no-link',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'specChanged',
    specFileName: 'orphan-spec.md',
    summary: 'Spec changed: orphan-spec.md',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('orphan-spec.md');
  expect(frame).not.toContain('\x1b]8;;');
});

test('it renders log file paths as terminal hyperlinks to the local file', () => {
  const notification = buildTypedNotification('agentCompleted', 'notif-log-link', {
    agentType: 'implementor',
    issueNumber: 10,
  });
  const notifWithLog = { ...notification, logFilePath: '/tmp/agent-session.log' };

  const { lastFrame } = setupRenderTest({ notifications: [notifWithLog] });

  const frame = lastFrame() ?? '';
  // The log link wraps (logs) with dimColor styling, so ANSI codes appear between
  // the OSC 8 URL terminator and the text. Assert the URL and text separately.
  expect(frame).toContain('\x1b]8;;file:///tmp/agent-session.log\x07');
  expect(frame).toContain('(logs)');
  expect(frame).toContain('\x1b]8;;\x07');
});

test('it renders log file paths for failed agent notifications as terminal hyperlinks', () => {
  const notification = buildTypedNotification('agentFailed', 'notif-fail-log-link', {
    agentType: 'reviewer',
    issueNumber: 5,
    error: 'crashed',
  });
  const notifWithLog = { ...notification, logFilePath: '/logs/reviewer.log' };

  const { lastFrame } = setupRenderTest({ notifications: [notifWithLog] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain('\x1b]8;;file:///logs/reviewer.log\x07');
  expect(frame).toContain('(logs)');
  expect(frame).toContain('\x1b]8;;\x07');
});

test('it renders issue references as hyperlinks in status change notifications', () => {
  const notification: Notification = {
    id: 'notif-status-link',
    timestamp: '2026-02-08T10:30:45.000Z',
    eventType: 'issueStatusChanged',
    issueNumber: 99,
    oldStatus: 'pending',
    newStatus: 'in-progress',
    summary: '#99: pending -> in-progress',
  };

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain(
    '\x1b]8;;https://github.com/test-owner/test-repo/issues/99\x07#99\x1b]8;;\x07',
  );
});

test('it renders issue references as hyperlinks in approved notifications', () => {
  const notification = buildTypedNotification('prApproved', 'notif-approved-link', {
    issueNumber: 25,
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  const frame = lastFrame() ?? '';
  expect(frame).toContain(
    // biome-ignore lint/security/noSecrets: OSC 8 escape sequence test fixture
    '\x1b]8;;https://github.com/test-owner/test-repo/issues/25\x07#25\x1b]8;;\x07',
  );
});

// ---------------------------------------------------------------------------
// Copy indicator
// ---------------------------------------------------------------------------

test('it shows a copy indicator for notifications with a clipboard command', () => {
  const notification = buildTypedNotification('issueNeedsRefinement', 'notif-copy', {
    resolutionGuidance: 'fix the spec',
    clipboardCommand: 'claude -p "fix the spec"',
  });

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).toContain('[copy]');
});

test('it does not show a copy indicator for notifications without a clipboard command', () => {
  const notification = buildTypedNotification('issueStatusChanged', 'notif-no-copy');

  const { lastFrame } = setupRenderTest({ notifications: [notification] });

  expect(lastFrame()).not.toContain('[copy]');
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('it shows newest notifications at the top of the list', () => {
  // Store convention: newest at index 0, oldest at end
  const notifications: Notification[] = [
    buildTypedNotification('recoveryPerformed', 'notif-3'),
    buildTypedNotification('dispatchReady', 'notif-2'),
    buildTypedNotification('dispatchReady', 'notif-1'),
  ];

  const { lastFrame } = setupRenderTest({ notifications });

  const frame = lastFrame() ?? '';
  const recoveryPos = frame.indexOf('recovered from stale');
  const readyPos = frame.indexOf('ready for dispatch');

  // notif-3 (recovery) is newest (index 0), should appear first (top)
  expect(recoveryPos).toBeLessThan(readyPos);
});

// ---------------------------------------------------------------------------
// Keyboard navigation (handleNotificationsInput)
// ---------------------------------------------------------------------------

test('it moves the selection down when the down arrow is pressed', () => {
  const notifications = [
    buildTypedNotification('dispatchReady', 'notif-1'),
    buildTypedNotification('dispatchReady', 'notif-2'),
    buildTypedNotification('dispatchReady', 'notif-3'),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 0);

  sendInput('', { downArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it moves the selection down when j is pressed', () => {
  const notifications = [
    buildTypedNotification('dispatchReady', 'notif-1'),
    buildTypedNotification('dispatchReady', 'notif-2'),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 0);

  sendInput('j', {});

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it moves the selection up when the up arrow is pressed', () => {
  const notifications = [
    buildTypedNotification('dispatchReady', 'notif-1'),
    buildTypedNotification('dispatchReady', 'notif-2'),
    buildTypedNotification('dispatchReady', 'notif-3'),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 2);

  sendInput('', { upArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(1);
});

test('it moves the selection up when k is pressed', () => {
  const notifications = [
    buildTypedNotification('dispatchReady', 'notif-1'),
    buildTypedNotification('dispatchReady', 'notif-2'),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 1);

  sendInput('k', {});

  expect(onSelectIndex).toHaveBeenCalledWith(0);
});

test('it does not move the selection above the first item', () => {
  const notifications = [
    buildTypedNotification('dispatchReady', 'notif-1'),
    buildTypedNotification('dispatchReady', 'notif-2'),
  ];

  const { sendInput, onSelectIndex } = setupInputTest(notifications, 0);

  sendInput('', { upArrow: true });

  expect(onSelectIndex).toHaveBeenCalledWith(0);
});

test('it does not move the selection below the last item', () => {
  const notifications = [
    buildTypedNotification('dispatchReady', 'notif-1'),
    buildTypedNotification('dispatchReady', 'notif-2'),
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
// Enter -- open context in browser
// ---------------------------------------------------------------------------

test('it opens the context URL when Enter is pressed on a notification with a URL', () => {
  // Store convention: newest at index 0
  const notifications: Notification[] = [
    {
      ...buildTypedNotification('specChanged', 'notif-2'),
      contextURL: 'https://github.com/owner/repo/commit/abc123',
    },
    buildTypedNotification('dispatchReady', 'notif-1'),
  ];

  // selectedIndex 0 = notif-2 (newest, at top)
  const { sendInput, openURL } = setupInputTest(notifications, 0);

  sendInput('', { return: true });

  expect(openURL).toHaveBeenCalledWith('https://github.com/owner/repo/commit/abc123');
});

test('it does not open anything when Enter is pressed on a notification without a URL', () => {
  const notifications = [buildTypedNotification('startup', 'notif-1')];

  const { sendInput, openURL } = setupInputTest(notifications, 0);

  sendInput('', { return: true });

  expect(openURL).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// c -- copy clipboard command
// ---------------------------------------------------------------------------

test('it copies the clipboard command when c is pressed on a notification with one', () => {
  const notification = buildTypedNotification('issueNeedsRefinement', 'notif-copy', {
    issueNumber: 3,
    resolutionGuidance: 'fix it',
    clipboardCommand: 'claude -p "fix the spec"',
  });

  const { sendInput, copyToClipboard } = setupInputTest([notification], 0);

  sendInput('c', {});

  expect(copyToClipboard).toHaveBeenCalledWith('claude -p "fix the spec"');
});

test('it does nothing when c is pressed on a notification without a clipboard command', () => {
  const notifications = [buildTypedNotification('dispatchReady', 'notif-1')];

  const { sendInput, copyToClipboard } = setupInputTest(notifications, 0);

  sendInput('c', {});

  expect(copyToClipboard).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AgentType = 'implementor' | 'reviewer' | 'planner';

interface BaseFields {
  id: string;
  timestamp: string;
  summary: string;
}

function buildBaseFields(id: string, eventType: string): BaseFields {
  return {
    id,
    timestamp: '2026-02-08T10:30:45.000Z',
    summary: `Test ${eventType}`,
  };
}

interface NotificationOverrides {
  agentType?: AgentType;
  issueNumber?: number;
  specCount?: number;
  error?: string;
  sessionID?: string;
  resolutionGuidance?: string;
  clipboardCommand?: string;
  oldStatus?: string | null;
  newStatus?: string;
  specFileName?: string;
  issueCount?: number;
  recoveriesPerformed?: number;
}

function buildAgentStartedNotification(
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  const agentType = overrides?.agentType ?? 'implementor';
  const base = {
    ...buildBaseFields(id, 'agentStarted'),
    eventType: 'agentStarted' as const,
    agentType,
  };
  if (agentType === 'planner' && overrides?.specCount !== undefined) {
    return { ...base, specCount: overrides.specCount };
  }
  if (agentType === 'planner') {
    return base;
  }
  return { ...base, issueNumber: overrides?.issueNumber ?? 1 };
}

function buildAgentCompletedNotification(
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  const agentType = overrides?.agentType ?? 'implementor';
  const base = {
    ...buildBaseFields(id, 'agentCompleted'),
    eventType: 'agentCompleted' as const,
    agentType,
  };
  if (agentType === 'planner' && overrides?.specCount !== undefined) {
    return { ...base, specCount: overrides.specCount };
  }
  if (agentType === 'planner') {
    return base;
  }
  return { ...base, issueNumber: overrides?.issueNumber ?? 1 };
}

function buildAgentFailedNotification(id: string, overrides?: NotificationOverrides): Notification {
  const agentType = overrides?.agentType ?? 'implementor';
  const base = {
    ...buildBaseFields(id, 'agentFailed'),
    eventType: 'agentFailed' as const,
    agentType,
    error: overrides?.error ?? 'err',
    sessionID: overrides?.sessionID ?? 'sess-1',
  };
  if (agentType === 'planner') {
    return base;
  }
  return { ...base, issueNumber: overrides?.issueNumber ?? 1 };
}

function buildAgentSkippedNotification(
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  const agentType = overrides?.agentType ?? 'implementor';
  const base = {
    ...buildBaseFields(id, 'agentSkipped'),
    eventType: 'agentSkipped' as const,
    agentType,
  };
  if (agentType === 'planner') {
    return base;
  }
  return { ...base, issueNumber: overrides?.issueNumber ?? 1 };
}

function buildPRApprovedNotification(id: string, overrides?: NotificationOverrides): Notification {
  return {
    ...buildBaseFields(id, 'prApproved'),
    eventType: 'prApproved' as const,
    issueNumber: overrides?.issueNumber ?? 1,
  };
}

function buildIssueNeedsRefinementNotification(
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  return {
    ...buildBaseFields(id, 'issueNeedsRefinement'),
    eventType: 'issueNeedsRefinement' as const,
    issueNumber: overrides?.issueNumber ?? 1,
    resolutionGuidance: overrides?.resolutionGuidance ?? 'Fix the spec',
    clipboardCommand: overrides?.clipboardCommand ?? 'claude -p "fix"',
  };
}

function buildIssueBlockedNotification(
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  return {
    ...buildBaseFields(id, 'issueBlocked'),
    eventType: 'issueBlocked' as const,
    issueNumber: overrides?.issueNumber ?? 1,
    resolutionGuidance: overrides?.resolutionGuidance ?? 'Resolve blocker',
  };
}

function buildIssueStatusChangedNotification(
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  return {
    ...buildBaseFields(id, 'issueStatusChanged'),
    eventType: 'issueStatusChanged' as const,
    issueNumber: overrides?.issueNumber ?? 1,
    oldStatus: overrides?.oldStatus ?? 'pending',
    newStatus: overrides?.newStatus ?? 'in-progress',
  };
}

function buildSpecChangedNotification(id: string, overrides?: NotificationOverrides): Notification {
  return {
    ...buildBaseFields(id, 'specChanged'),
    eventType: 'specChanged' as const,
    specFileName: overrides?.specFileName ?? 'test.md',
  };
}

function buildIssueNumberNotification(
  eventType:
    | 'recoveryPerformed'
    | 'dispatchReady'
    | 'issueRefined'
    | 'issueUnblocked'
    | 'prUnapproved'
    | 'ciCheckRecovered'
    | 'issueRemoved',
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  return {
    ...buildBaseFields(id, eventType),
    eventType,
    issueNumber: overrides?.issueNumber ?? 1,
  };
}

function buildStartupNotification(id: string, overrides?: NotificationOverrides): Notification {
  return {
    ...buildBaseFields(id, 'startup'),
    eventType: 'startup' as const,
    issueCount: overrides?.issueCount ?? 5,
    recoveriesPerformed: overrides?.recoveriesPerformed ?? 0,
  };
}

function buildTypedNotification(
  eventType: Notification['eventType'],
  id: string,
  overrides?: NotificationOverrides,
): Notification {
  return match(eventType)
    .with('agentStarted', () => buildAgentStartedNotification(id, overrides))
    .with('agentCompleted', () => buildAgentCompletedNotification(id, overrides))
    .with('agentFailed', () => buildAgentFailedNotification(id, overrides))
    .with('agentSkipped', () => buildAgentSkippedNotification(id, overrides))
    .with('issueStatusChanged', () => buildIssueStatusChangedNotification(id, overrides))
    .with('specChanged', () => buildSpecChangedNotification(id, overrides))
    .with('recoveryPerformed', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('dispatchReady', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('prApproved', () => buildPRApprovedNotification(id, overrides))
    .with('issueNeedsRefinement', () => buildIssueNeedsRefinementNotification(id, overrides))
    .with('issueBlocked', () => buildIssueBlockedNotification(id, overrides))
    .with('issueRefined', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('issueUnblocked', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('prUnapproved', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('ciCheckFailed', () => ({
      ...buildBaseFields(id, 'ciCheckFailed'),
      eventType: 'ciCheckFailed' as const,
      issueNumber: overrides?.issueNumber ?? 1,
      prNumber: 10,
    }))
    .with('ciCheckRecovered', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('issueRemoved', (t) => buildIssueNumberNotification(t, id, overrides))
    .with('startup', () => buildStartupNotification(id, overrides))
    .exhaustive();
}
