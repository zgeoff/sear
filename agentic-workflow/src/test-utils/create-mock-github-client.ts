import { vi } from 'vitest';
import type { GitHubClient } from '../engine/github-client/types.js';

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
