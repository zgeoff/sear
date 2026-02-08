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

test('buildClosesPattern matches "Closes #4" at end of line', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #4')).toBe(true);
});

test('buildClosesPattern matches "Closes #4" followed by whitespace', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #4 and more text')).toBe(true);
});

test('buildClosesPattern matches "Closes #4" followed by punctuation', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #4.')).toBe(true);
  expect(pattern.test('Closes #4, also fixes things')).toBe(true);
});

test('buildClosesPattern does not match "Closes #42" when looking for #4', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #42')).toBe(false);
});

test('buildClosesPattern does not match "Closes #40" when looking for #4', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Closes #40')).toBe(false);
});

test('buildClosesPattern matches "Closes #4" on a new line in multiline text', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('Some text\nCloses #4\nMore text')).toBe(true);
});

test('buildClosesPattern matches "Closes #4" followed by closing paren', () => {
  const pattern = buildClosesPattern(4);
  expect(pattern.test('(Closes #4)')).toBe(true);
});

// ---------------------------------------------------------------------------
// getIssueDetails
// ---------------------------------------------------------------------------

test('getIssueDetails returns issue body, labels, and creation date', async () => {
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

test('getIssueDetails handles null body', async () => {
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

test('getIssueDetails handles string labels', async () => {
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

test('getIssueDetails propagates API errors', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.issues.get).mockRejectedValue(new Error('Not Found'));

  await expect(getIssueDetails(config, 999)).rejects.toThrow('Not Found');
});

// ---------------------------------------------------------------------------
// getPRForIssue
// ---------------------------------------------------------------------------

test('getPRForIssue returns PR details when a linked PR exists', async () => {
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

test('getPRForIssue returns null when no linked PR exists', async () => {
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

test('getPRForIssue returns null when PR list is empty', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] } as never);

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('getPRForIssue uses word-boundary match and does not match Closes #42 for issue #4', async () => {
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

test('getPRForIssue matches Closes #4 followed by period', async () => {
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

test('getPRForIssue maps pending CI status', async () => {
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

test('getPRForIssue maps failure CI status', async () => {
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

test('getPRForIssue uses check runs when present (all success)', async () => {
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

test('getPRForIssue uses check runs when present (one failure)', async () => {
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

test('getPRForIssue uses check runs when present (in progress)', async () => {
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

test('getPRForIssue defaults to pending when CI status check fails', async () => {
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

test('getPRForIssue propagates API errors from pulls.list', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockRejectedValue(new Error('Rate limited'));

  await expect(getPRForIssue(config, 10)).rejects.toThrow('Rate limited');
});

test('getPRForIssue handles PR with null body', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [{ number: 110, body: null }],
  } as never);

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('getPRForIssue matches first PR when multiple match', async () => {
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
