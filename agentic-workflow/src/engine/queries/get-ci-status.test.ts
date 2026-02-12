import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import { getCIStatus } from './get-ci-status.ts';
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

// ---------------------------------------------------------------------------
// getCIStatus — overall status derivation
// ---------------------------------------------------------------------------

test('it reports failure when combined status is failure', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('failure');
});

test('it reports failure when any check run has a failure conclusion', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        {
          name: 'test-success',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/success',
        },
        {
          name: 'test-failure',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://example.com/failure',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('failure');
});

test('it reports failure when any check run has a cancelled conclusion', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [
        {
          name: 'cancelled-check',
          status: 'completed',
          conclusion: 'cancelled',
          details_url: 'https://example.com/cancelled',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('failure');
});

test('it reports failure when any check run has a timed_out conclusion', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [
        {
          name: 'timedout-check',
          status: 'completed',
          conclusion: 'timed_out',
          details_url: 'https://example.com/timeout',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('failure');
});

test('it reports pending when any check run has not completed', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [
        {
          name: 'in-progress-check',
          status: 'in_progress',
          conclusion: null,
          details_url: 'https://example.com/progress',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('pending');
});

test('it reports pending when combined status is pending with real statuses', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('pending');
});

test('it reports pending when no CI is configured', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('pending');
});

test('it reports success when all check runs succeed and combined status is success', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        {
          name: 'test-1',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/1',
        },
        {
          name: 'test-2',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/2',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('success');
});

test('it reports success when combined status has no statuses and all check runs succeed', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [
        {
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/test',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('success');
});

test('it defaults to pending when CI status API calls fail', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockRejectedValue(new Error('API error'));

  const result = await getCIStatus(config, 42);
  expect(result.overall).toBe('pending');
});

// ---------------------------------------------------------------------------
// getCIStatus — failedCheckRuns
// ---------------------------------------------------------------------------

test('it returns failed check runs when overall status is failure', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 3,
      check_runs: [
        {
          name: 'test-success',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/success',
        },
        {
          name: 'test-failure',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://example.com/failure',
        },
        {
          name: 'test-cancelled',
          status: 'completed',
          conclusion: 'cancelled',
          details_url: 'https://example.com/cancelled',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);

  expect(result.failedCheckRuns).toHaveLength(2);
  expect(result.failedCheckRuns).toStrictEqual([
    {
      name: 'test-failure',
      status: 'completed',
      conclusion: 'failure',
      detailsURL: 'https://example.com/failure',
    },
    {
      name: 'test-cancelled',
      status: 'completed',
      conclusion: 'cancelled',
      detailsURL: 'https://example.com/cancelled',
    },
  ]);
});

test('it returns only timed_out check runs in failedCheckRuns', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        {
          name: 'test-timeout',
          status: 'completed',
          conclusion: 'timed_out',
          details_url: 'https://example.com/timeout',
        },
        {
          name: 'test-neutral',
          status: 'completed',
          conclusion: 'neutral',
          details_url: 'https://example.com/neutral',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);

  expect(result.failedCheckRuns).toHaveLength(1);
  expect(result.failedCheckRuns[0]).toStrictEqual({
    name: 'test-timeout',
    status: 'completed',
    conclusion: 'timed_out',
    detailsURL: 'https://example.com/timeout',
  });
});

test('it returns empty array for failedCheckRuns when overall status is success', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [
        {
          name: 'test',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/test',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.failedCheckRuns).toStrictEqual([]);
});

test('it returns empty array for failedCheckRuns when overall status is pending', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [
        {
          name: 'test',
          status: 'in_progress',
          conclusion: null,
          details_url: 'https://example.com/test',
        },
      ],
    },
  });

  const result = await getCIStatus(config, 42);
  expect(result.failedCheckRuns).toStrictEqual([]);
});

test('it handles check runs with missing name or details_url fields', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'failure' }],
    },
  });

  const result = await getCIStatus(config, 42);

  expect(result.failedCheckRuns).toHaveLength(1);
  expect(result.failedCheckRuns[0]).toStrictEqual({
    name: '',
    status: 'completed',
    conclusion: 'failure',
    detailsURL: '',
  });
});

test('it calls pulls.get to obtain head.sha', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 42,
      title: 'test PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/42',
      head: { sha: 'specific-sha-123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  await getCIStatus(config, 42);

  expect(octokit.pulls.get).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 42,
  });

  expect(octokit.repos.getCombinedStatusForRef).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    ref: 'specific-sha-123',
  });

  expect(octokit.checks.listForRef).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    ref: 'specific-sha-123',
  });
});
