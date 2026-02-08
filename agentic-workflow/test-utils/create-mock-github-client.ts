import { vi } from 'vitest';
import type { GitHubClient } from '../src/engine/github-client.js';

export function createMockGitHubClient(): GitHubClient {
  return {
    issues: {
      get: vi.fn(),
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
