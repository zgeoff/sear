import { vi } from 'vitest';
import type { Engine, EngineCommand, EngineEvent } from '../../types';

type EventHandler = (event: EngineEvent) => void;

export type MockEngineOverrides = {
  start?: Engine['start'];
  getIssueDetails?: Engine['getIssueDetails'];
  getPRForIssue?: Engine['getPRForIssue'];
  getAgentStream?: Engine['getAgentStream'];
};

export type MockEngineResult = {
  engine: Engine;
  emit: (event: EngineEvent) => void;
  sentCommands: EngineCommand[];
};

export function createMockEngine(overrides?: MockEngineOverrides): MockEngineResult {
  const handlers: EventHandler[] = [];
  const sentCommands: EngineCommand[] = [];

  const engine: Engine = {
    start:
      overrides?.start ?? vi.fn(() => Promise.resolve({ issueCount: 0, recoveriesPerformed: 0 })),
    on(handler) {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    },
    send(command) {
      sentCommands.push(command);
    },
    getIssueDetails:
      overrides?.getIssueDetails ??
      vi.fn(() =>
        Promise.resolve({
          number: 1,
          title: 'Test',
          body: 'body',
          labels: ['task:implement'],
          createdAt: '2026-01-01T00:00:00Z',
        }),
      ),
    getPRForIssue:
      overrides?.getPRForIssue ??
      vi.fn(() =>
        Promise.resolve({
          number: 10,
          title: 'PR Title',
          changedFilesCount: 3,
          ciStatus: 'success' as const,
          url: 'https://github.com/owner/repo/pull/10',
        }),
      ),
    getAgentStream: overrides?.getAgentStream ?? vi.fn(() => null),
  };

  function emit(event: EngineEvent) {
    for (const handler of handlers) {
      handler(event);
    }
  }

  return { engine, emit, sentCommands };
}
