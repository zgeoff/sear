import type { Octokit } from '@octokit/rest';
import { expect, test, vi } from 'vitest';
import type { QueriesConfig } from './queries.js';
import { buildClosesPattern, getIssueDetails, getPRForIssue } from './queries.js';

function createMockOctokit() {
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
    },
    checks: {
      listForRef: vi.fn(),
    },
  } as unknown as Octokit;
}

function setupTest() {
  const octokit = createMockOctokit();
  const config: QueriesConfig = {
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
  };
  return { octokit, config };
}

// ---------------------------------------------------------------------------
// buildClosesPattern
// ---------------------------------------------------------------------------

test('it matches a closing reference at end of line', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #4')).toBe(true);
});

test('it matches a closing reference followed by whitespace', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #4 and more text')).toBe(true);
});

test('it matches a closing reference followed by punctuation', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #4.')).toBe(true);
  expect(pattern.test('Closes #4, also fixes things')).toBe(true);
});

test('it does not match a closing reference with extra trailing digits', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #42')).toBe(false);
});

test('it does not match a closing reference whose number merely starts with the target', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #40')).toBe(false);
});

test('it matches a closing reference on a new line in multiline text', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Some text\nCloses #4\nMore text')).toBe(true);
});

test('it matches a closing reference followed by a closing parenthesis', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('(Closes #4)')).toBe(true);
});

// ---------------------------------------------------------------------------
// getIssueDetails
// ---------------------------------------------------------------------------

test('it returns the body, labels, and creation date for an issue', async () => {
  const { octokit, config } = setupTest();

  const mockIssue = {
    number: 10,
    title: 'Implement query interface',
    body: '## Objective\n\nImplement the query interface.',
    labels: [{ name: 'task:implement' }, { name: 'status:pending' }, { name: 'priority:medium' }],
    created_at: '2026-02-08T10:00:00Z',
  };

  vi.mocked(octokit.issues.get).mockResolvedValue({ data: mockIssue } as never);

  const result = await getIssueDetails(config, 10);

  expect(result).toEqual({
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
  } as never);

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
  } as never);

  const result = await getIssueDetails(config, 5);
  expect(result.labels).toEqual(['label-a', 'label-b']);
});

test('it propagates API errors when fetching issue details', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.issues.get).mockRejectedValue(new Error('Not Found'));

  await expect(getIssueDetails(config, 999)).rejects.toThrow('Not Found');
});

// ---------------------------------------------------------------------------
// getPRForIssue
// ---------------------------------------------------------------------------

test('it returns PR details when a linked pull request exists', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      {
        number: 20,
        body: 'Closes #10',
        head: { sha: 'abc123' },
      },
    ],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 20,
      title: 'feat(agentic-workflow): implement queries',
      changed_files: 3,
      html_url: 'https://github.com/test-owner/test-repo/pull/20',
      head: { sha: 'abc123' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  } as never);

  const result = await getPRForIssue(config, 10);

  expect(result).toEqual({
    number: 20,
    title: 'feat(agentic-workflow): implement queries',
    changedFilesCount: 3,
    ciStatus: 'success',
    url: 'https://github.com/test-owner/test-repo/pull/20',
  });
});

test('it returns null when no pull request links to the issue', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      { number: 30, body: 'Closes #99' },
      { number: 31, body: 'Unrelated PR' },
    ],
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('it returns null when the pull request list is empty', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] } as never);

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('it avoids false matches when the issue number is a prefix of another number', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      { number: 50, body: 'Closes #42' },
      { number: 51, body: 'Closes #421' },
    ],
  } as never);

  const result = await getPRForIssue(config, 4);
  expect(result).toBeNull();
});

test('it finds a linked PR when the closing reference is followed by a period', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 60, body: 'Fixes things. Closes #4.' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 60,
      title: 'fix: something',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/60',
      head: { sha: 'def456' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 1 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  } as never);

  const result = await getPRForIssue(config, 4);
  expect(result).not.toBeNull();
  expect(result!.number).toBe(60);
});

test('it reports pending CI status when checks have not completed', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 70, body: 'Closes #10' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 70,
      title: 'feat: test',
      changed_files: 2,
      html_url: 'https://github.com/test-owner/test-repo/pull/70',
      head: { sha: 'sha-pending' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 1 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result!.ciStatus).toBe('pending');
});

test('it reports failure CI status when status checks fail', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 80, body: 'Closes #10' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 80,
      title: 'feat: test',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/80',
      head: { sha: 'sha-fail' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result!.ciStatus).toBe('failure');
});

test('it reports success when all check runs complete successfully', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 90, body: 'Closes #10' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 90,
      title: 'feat: test',
      changed_files: 5,
      html_url: 'https://github.com/test-owner/test-repo/pull/90',
      head: { sha: 'sha-checks' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
      ],
    },
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result!.ciStatus).toBe('success');
});

test('it reports failure when any check run has a failure conclusion', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 91, body: 'Closes #10' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 91,
      title: 'feat: test',
      changed_files: 3,
      html_url: 'https://github.com/test-owner/test-repo/pull/91',
      head: { sha: 'sha-checks-fail' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ],
    },
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result!.ciStatus).toBe('failure');
});

test('it reports pending when a check run is still in progress', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 92, body: 'Closes #10' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 92,
      title: 'feat: test',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/92',
      head: { sha: 'sha-checks-pending' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'in_progress', conclusion: null }],
    },
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result!.ciStatus).toBe('pending');
});

test('it defaults to pending when the CI status API call fails', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 100, body: 'Closes #10' }],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'feat: test',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/100',
      head: { sha: 'sha-error' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockRejectedValue(new Error('API error'));

  const result = await getPRForIssue(config, 10);
  expect(result!.ciStatus).toBe('pending');
});

test('it propagates API errors when listing pull requests', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockRejectedValue(new Error('Rate limited'));

  await expect(getPRForIssue(config, 10)).rejects.toThrow('Rate limited');
});

test('it skips pull requests with a null body', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 110, body: null }],
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('it returns the first matching PR when multiple link to the same issue', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      { number: 120, body: 'Closes #10' },
      { number: 121, body: 'Also Closes #10' },
    ],
  } as never);

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 120,
      title: 'first PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/120',
      head: { sha: 'sha-first' },
    },
  } as never);

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  } as never);

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result!.number).toBe(120);
  expect(octokit.pulls.get).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 120,
  });
});
