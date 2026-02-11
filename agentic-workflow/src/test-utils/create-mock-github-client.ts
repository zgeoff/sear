import { vi } from 'vitest';
import type { GitHubClient } from '../engine/github-client/types.ts';

export function createMockGitHubClient(): GitHubClient {
  return {
    issues: {
      get: vi.fn(),
      listForRepo: vi.fn(),
      addLabels: vi.fn(),
      removeLabel: vi.fn(),
    },
    pulls: {
      list: vi.fn(),
      get: vi.fn(),
      listFiles: vi.fn(),
      listReviews: vi.fn(),
      listReviewComments: vi.fn(),
    },
    repos: {
      getCombinedStatusForRef: vi.fn(),
      getContent: vi.fn(),
    },
    checks: {
      listForRef: vi.fn(),
    },
    git: {
      getTree: vi.fn(),
      getRef: vi.fn(),
    },
  };
}
