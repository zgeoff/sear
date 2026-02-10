import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import { getIssueDetails } from './get-issue-details.ts';
import type { QueriesConfig } from './types.ts';

function setupTest(): {
  octokit: ReturnType<typeof createMockGitHubClient>;
  config: QueriesConfig;
} {
  const octokit = createMockGitHubClient();
  const config: QueriesConfig = {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  };
  return { octokit, config };
}

test('it returns the body, labels, and creation date for an issue', async () => {
  const { octokit, config } = setupTest();

  const mockIssue = {
    number: 10,
    title: 'Implement query interface',
    body: '## Objective\n\nImplement the query interface.',
    labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:medium' }],
    created_at: '2026-02-08T10:00:00Z',
  };

  vi.mocked(octokit.issues.get).mockResolvedValue({ data: mockIssue });

  const result = await getIssueDetails(config, 10);

  expect(result).toStrictEqual({
    number: 10,
    title: 'Implement query interface',
    body: '## Objective\n\nImplement the query interface.',
    labels: ['task:implement', 'status:pending', 'priority:medium'],
    createdAt: '2026-02-08T10:00:00Z',
  });

  expect(octokit.issues.get).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    issue_number: 10,
  });
});

test('it returns an empty string when the issue body is null', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.issues.get).mockResolvedValue({
    data: {
      number: 5,
      title: 'No body issue',
      body: null,
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
    },
  });

  const result = await getIssueDetails(config, 5);
  expect(result.body).toBe('');
});

test('it extracts label names when labels are plain strings', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.issues.get).mockResolvedValue({
    data: {
      number: 5,
      title: 'String labels',
      body: 'body',
      labels: ['label-a', 'label-b'],
      created_at: '2026-01-01T00:00:00Z',
    },
  });

  const result = await getIssueDetails(config, 5);
  expect(result.labels).toStrictEqual(['label-a', 'label-b']);
});

test('it extracts label names from mixed formats and discards objects without a name', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.issues.get).mockResolvedValue({
    data: {
      number: 5,
      title: 'Mixed labels',
      body: 'body',
      labels: ['bare-string', { name: 'named-object' }, {}, { name: 'another-named' }],
      created_at: '2026-01-01T00:00:00Z',
    },
  });

  const result = await getIssueDetails(config, 5);
  expect(result.labels).toStrictEqual(['bare-string', 'named-object', 'another-named']);
});

test('it propagates API errors when fetching issue details', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.issues.get).mockRejectedValue(new Error('Not Found'));

  await expect(getIssueDetails(config, 999)).rejects.toThrow('Not Found');
});
