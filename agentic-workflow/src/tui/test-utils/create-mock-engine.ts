import { vi } from 'vitest';
import type { Engine, EngineCommand, EngineEvent } from '../../types.ts';

type EventHandler = (event: EngineEvent) => void;

export interface MockEngineOverrides {
  start?: Engine['start'];
  getIssueDetails?: Engine['getIssueDetails'];
  getPRForIssue?: Engine['getPRForIssue'];
  getPRFiles?: Engine['getPRFiles'];
  getPRReviews?: Engine['getPRReviews'];
  getCIStatus?: Engine['getCIStatus'];
  getAgentStream?: Engine['getAgentStream'];
}

export interface MockEngineResult {
  engine: Engine;
  emit: (event: EngineEvent) => void;
  sentCommands: EngineCommand[];
}

export function createMockEngine(overrides?: MockEngineOverrides): MockEngineResult {
  const handlers: EventHandler[] = [];
  const sentCommands: EngineCommand[] = [];

  const engine: Engine = {
    start: overrides?.start ?? vi.fn(async () => ({ issueCount: 0, recoveriesPerformed: 0 })),
    on(handler: EventHandler): () => void {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) {
          handlers.splice(idx, 1);
        }
      };
    },
    send: vi.fn((command: EngineCommand): void => {
      sentCommands.push(command);
    }),
    getIssueDetails:
      overrides?.getIssueDetails ??
      vi.fn(async () => ({
        number: 1,
        title: 'Test',
        body: 'body',
        labels: ['task:implement'],
        createdAt: '2026-01-01T00:00:00Z',
      })),
    getPRForIssue:
      overrides?.getPRForIssue ??
      vi.fn(async () => ({
        number: 10,
        title: 'PR Title',
        changedFilesCount: 3,
        ciStatus: 'success' as const,
        url: 'https://github.com/owner/repo/pull/10',
        isDraft: false,
        headRefName: 'feature-branch',
      })),
    getPRFiles: overrides?.getPRFiles ?? vi.fn(async () => []),
    getPRReviews: overrides?.getPRReviews ?? vi.fn(async () => ({ reviews: [], comments: [] })),
    getCIStatus:
      overrides?.getCIStatus ??
      vi.fn(async () => ({ overall: 'success' as const, failedCheckRuns: [] })),
    getAgentStream: overrides?.getAgentStream ?? vi.fn(() => null),
  };

  function emit(event: EngineEvent): void {
    for (const handler of handlers) {
      handler(event);
    }
  }

  return { engine, emit, sentCommands };
}
