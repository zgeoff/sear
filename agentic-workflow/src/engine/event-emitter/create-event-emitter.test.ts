import { expect, test, vi } from 'vitest';
import type { EngineEvent } from '../../types';
import { createEventEmitter } from './create-event-emitter';

function setupTest() {
  const emitter = createEventEmitter();
  return { emitter };
}

test('it returns an unsubscribe function when subscribing to events', () => {
  const { emitter } = setupTest();
  const handler = vi.fn();
  const unsubscribe = emitter.on(handler);
  expect(typeof unsubscribe).toBe('function');
});

test('it delivers an emitted event to the subscribed handler', () => {
  const { emitter } = setupTest();
  const handler = vi.fn();
  emitter.on(handler);

  const event: EngineEvent = {
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Test issue',
    oldStatus: null,
    newStatus: 'pending',
    priorityLabel: 'priority:high',
    createdAt: '2026-01-01T00:00:00Z',
  };

  emitter.emit(event);
  expect(handler).toHaveBeenCalledWith(event);
  expect(handler).toHaveBeenCalledTimes(1);
});

test('it delivers an emitted event to all subscribed handlers', () => {
  const { emitter } = setupTest();
  const handler1 = vi.fn();
  const handler2 = vi.fn();
  const handler3 = vi.fn();
  emitter.on(handler1);
  emitter.on(handler2);
  emitter.on(handler3);

  const event: EngineEvent = {
    type: 'dispatchReady',
    issueNumber: 5,
    statusLabel: 'status:pending',
  };

  emitter.emit(event);
  expect(handler1).toHaveBeenCalledWith(event);
  expect(handler2).toHaveBeenCalledWith(event);
  expect(handler3).toHaveBeenCalledWith(event);
});

test('it stops delivering events to a handler after unsubscribing', () => {
  const { emitter } = setupTest();
  const handler = vi.fn();
  const unsubscribe = emitter.on(handler);

  const event1: EngineEvent = {
    type: 'issueRemoved',
    issueNumber: 10,
  };

  emitter.emit(event1);
  expect(handler).toHaveBeenCalledTimes(1);

  unsubscribe();

  const event2: EngineEvent = {
    type: 'issueRemoved',
    issueNumber: 11,
  };

  emitter.emit(event2);
  expect(handler).toHaveBeenCalledTimes(1);
});

test('it continues delivering events to remaining handlers after one unsubscribes', () => {
  const { emitter } = setupTest();
  const handler1 = vi.fn();
  const handler2 = vi.fn();
  const unsubscribe1 = emitter.on(handler1);
  emitter.on(handler2);

  unsubscribe1();

  const event: EngineEvent = {
    type: 'recoveryPerformed',
    issueNumber: 3,
    oldStatus: 'in-progress',
    newStatus: 'pending',
  };

  emitter.emit(event);
  expect(handler1).not.toHaveBeenCalled();
  expect(handler2).toHaveBeenCalledWith(event);
});

test('it invokes handlers synchronously in subscription order', () => {
  const { emitter } = setupTest();
  const callOrder: number[] = [];

  emitter.on(() => callOrder.push(1));
  emitter.on(() => callOrder.push(2));

  const event: EngineEvent = {
    type: 'issueRemoved',
    issueNumber: 1,
  };

  emitter.emit(event);

  // If handlers were async, this would not be populated yet
  expect(callOrder).toEqual([1, 2]);
});

test('it accepts and delivers all engine event types', () => {
  const { emitter } = setupTest();
  const handler = vi.fn();
  emitter.on(handler);

  const events: EngineEvent[] = [
    {
      type: 'issueStatusChanged',
      issueNumber: 1,
      title: 'Test',
      oldStatus: null,
      newStatus: 'pending',
      priorityLabel: 'priority:high',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      type: 'specChanged',
      filePath: 'docs/specs/test.md',
      frontmatterStatus: 'approved',
      commitSHA: 'abc123',
    },
    {
      type: 'agentStarted',
      agentType: 'implementor',
      issueNumber: 1,
      sessionID: 'session-1',
    },
    {
      type: 'agentCompleted',
      agentType: 'reviewer',
      issueNumber: 2,
      sessionID: 'session-2',
    },
    {
      type: 'agentFailed',
      agentType: 'implementor',
      issueNumber: 3,
      error: 'timeout',
      sessionID: 'session-3',
      worktreePath: '.worktrees/issue-3',
    },
    {
      type: 'agentSkipped',
      agentType: 'planner',
      specPaths: ['docs/specs/test.md'],
    },
    {
      type: 'dispatchReady',
      issueNumber: 4,
      statusLabel: 'status:pending',
    },
    {
      type: 'notification',
      issueNumber: 5,
      statusLabel: 'status:needs-refinement',
      clipboardCommand: 'claude -p "Use /spec-writing..."',
      contextURL: 'https://github.com/owner/repo/issues/5',
      resolutionGuidance: 'After amending the spec, change the label to status:unblocked.',
    },
    {
      type: 'notificationDismissed',
      issueNumber: 5,
    },
    {
      type: 'issueRemoved',
      issueNumber: 6,
    },
    {
      type: 'recoveryPerformed',
      issueNumber: 7,
      oldStatus: 'in-progress',
      newStatus: 'pending',
    },
  ];

  for (const event of events) {
    emitter.emit(event);
  }

  expect(handler).toHaveBeenCalledTimes(events.length);
});

test('it does not throw when emitting with no subscribers', () => {
  const { emitter } = setupTest();

  const event: EngineEvent = {
    type: 'issueRemoved',
    issueNumber: 1,
  };

  expect(() => emitter.emit(event)).not.toThrow();
});
