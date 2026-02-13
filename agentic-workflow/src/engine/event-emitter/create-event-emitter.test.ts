import { expect, test, vi } from 'vitest';
import type { EngineEvent } from '../../types.ts';
import { createEventEmitter } from './create-event-emitter.ts';

function setupTest(): { emitter: ReturnType<typeof createEventEmitter> } {
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
    type: 'agentStarted',
    agentType: 'implementor',
    issueNumber: 5,
    sessionID: 'session-5',
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
    type: 'issueStatusChanged',
    issueNumber: 10,
    title: 'Issue 10',
    oldStatus: null,
    newStatus: null,
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  };

  emitter.emit(event1);
  expect(handler).toHaveBeenCalledTimes(1);

  unsubscribe();

  const event2: EngineEvent = {
    type: 'issueStatusChanged',
    issueNumber: 11,
    title: 'Issue 11',
    oldStatus: null,
    newStatus: null,
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
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
    type: 'issueStatusChanged',
    issueNumber: 3,
    title: 'Issue 3',
    oldStatus: 'in-progress',
    newStatus: 'pending',
    priorityLabel: 'priority:high',
    createdAt: '2026-01-01T00:00:00Z',
    isRecovery: true,
  };

  emitter.emit(event);
  expect(handler1).not.toHaveBeenCalled();
  expect(handler2).toHaveBeenCalledWith(event);
});

test('it invokes handlers synchronously in subscription order', () => {
  const { emitter } = setupTest();
  const callOrder: number[] = [];

  emitter.on(() => {
    callOrder.push(1);
  });
  emitter.on(() => {
    callOrder.push(2);
  });

  const event: EngineEvent = {
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Issue 1',
    oldStatus: null,
    newStatus: null,
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  };

  emitter.emit(event);

  // If handlers were async, this would not be populated yet
  expect(callOrder).toStrictEqual([1, 2]);
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
      changeType: 'added',
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
      branchName: 'issue-3-1700000000',
    },
    {
      type: 'prLinked',
      issueNumber: 4,
      prNumber: 10,
      url: 'https://github.com/owner/repo/pull/10',
      ciStatus: null,
    },
    {
      type: 'ciStatusChanged',
      prNumber: 10,
      issueNumber: 5,
      oldCIStatus: null,
      newCIStatus: 'failure',
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
    type: 'issueStatusChanged',
    issueNumber: 1,
    title: 'Issue 1',
    oldStatus: null,
    newStatus: null,
    priorityLabel: 'priority:medium',
    createdAt: '2026-01-01T00:00:00Z',
  };

  expect(() => emitter.emit(event)).not.toThrow();
});
