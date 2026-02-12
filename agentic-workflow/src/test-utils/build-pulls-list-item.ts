import type { PullsListItem } from '../engine/github-client/types.ts';

export function buildPullsListItem(overrides?: Partial<PullsListItem>): PullsListItem {
  return {
    number: 1,
    title: 'Test PR',
    html_url: 'https://github.com/owner/repo/pull/1',
    user: { login: 'testuser' },
    head: { sha: 'abc123', ref: 'test-branch' },
    body: 'Test body',
    draft: false,
    ...overrides,
  };
}
