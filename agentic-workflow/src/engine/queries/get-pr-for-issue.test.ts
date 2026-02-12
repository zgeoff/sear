import { expect, test, vi } from 'vitest';
import { buildPullsListItem } from '../../test-utils/build-pulls-list-item.ts';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import { buildClosingKeywordPattern, getPRForIssue } from './get-pr-for-issue.ts';
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

// biome-ignore lint/nursery/useExplicitType: Optional parameter with default value
function setupLinkedPr(
  octokit: ReturnType<typeof createMockGitHubClient>,
  body: string,
  draft = false,
): void {
  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 20, body, draft })],
  });
  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 20,
      title: 'feat: test',
      changed_files: 3,
      html_url: 'https://github.com/test-owner/test-repo/pull/20',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft,
    },
  });
  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  });
  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });
}

// ---------------------------------------------------------------------------
// buildClosingKeywordPattern — keyword variants
// ---------------------------------------------------------------------------

test('it matches a closing reference with "Closes"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closes #4')).toBe(true);
});

test('it matches a closing reference with "Close"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Close #4')).toBe(true);
});

test('it matches a closing reference with "Closed"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closed #4')).toBe(true);
});

test('it matches a closing reference with "Fixes"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Fixes #4')).toBe(true);
});

test('it matches a closing reference with "Fix"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Fix #4')).toBe(true);
});

test('it matches a closing reference with "Fixed"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Fixed #4')).toBe(true);
});

test('it matches a closing reference with "Resolves"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Resolves #4')).toBe(true);
});

test('it matches a closing reference with "Resolve"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Resolve #4')).toBe(true);
});

test('it matches a closing reference with "Resolved"', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Resolved #4')).toBe(true);
});

// ---------------------------------------------------------------------------
// buildClosingKeywordPattern — case insensitivity
// ---------------------------------------------------------------------------

test('it matches closing keywords in lowercase', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('closes #4')).toBe(true);
  expect(pattern.test('fixes #4')).toBe(true);
  expect(pattern.test('resolves #4')).toBe(true);
});

test('it matches closing keywords in uppercase', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('CLOSES #4')).toBe(true);
  expect(pattern.test('FIXES #4')).toBe(true);
  expect(pattern.test('RESOLVES #4')).toBe(true);
});

test('it matches closing keywords in mixed case', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('cLoSeS #4')).toBe(true);
});

// ---------------------------------------------------------------------------
// buildClosingKeywordPattern — word boundary
// ---------------------------------------------------------------------------

test('it matches a closing reference at end of line', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closes #4')).toBe(true);
});

test('it matches a closing reference followed by whitespace', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closes #4 and more text')).toBe(true);
});

test('it matches a closing reference followed by punctuation', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closes #4.')).toBe(true);
  expect(pattern.test('Closes #4, also fixes things')).toBe(true);
});

test('it does not match a closing reference with extra trailing digits', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closes #42')).toBe(false);
});

test('it does not match a closing reference whose number merely starts with the target', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Closes #40')).toBe(false);
});

test('it matches a closing reference on a new line in multiline text', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('Some text\nCloses #4\nMore text')).toBe(true);
});

test('it matches a closing reference followed by a closing parenthesis', () => {
  const pattern = buildClosingKeywordPattern(4);
  expect(pattern.test('(Closes #4)')).toBe(true);
});

// ---------------------------------------------------------------------------
// getPRForIssue — PR linkage
// ---------------------------------------------------------------------------

test('it returns PR details when a linked pull request exists', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 20, body: 'Closes #10', draft: false })],
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 20,
      title: 'feat(agentic-workflow): implement queries',
      changed_files: 3,
      html_url: 'https://github.com/test-owner/test-repo/pull/20',
      head: { sha: 'abc123', ref: 'feature-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10);

  expect(result).toStrictEqual({
    number: 20,
    title: 'feat(agentic-workflow): implement queries',
    changedFilesCount: 3,
    ciStatus: 'success',
    url: 'https://github.com/test-owner/test-repo/pull/20',
    isDraft: false,
    headRefName: 'feature-branch',
  });
});

test('it returns null when no pull request links to the issue', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      buildPullsListItem({ number: 30, body: 'Closes #99', draft: false }),
      buildPullsListItem({ number: 31, body: 'Unrelated PR', draft: false }),
    ],
  });

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('it returns null when the pull request list is empty', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({ data: [] });

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('it avoids false matches when the issue number is a prefix of another number', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      buildPullsListItem({ number: 50, body: 'Closes #42', draft: false }),
      buildPullsListItem({ number: 51, body: 'Closes #421', draft: false }),
    ],
  });

  const result = await getPRForIssue(config, 4);
  expect(result).toBeNull();
});

test('it finds a linked PR when the body uses "Fixes" keyword', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Fixes #10');

  const result = await getPRForIssue(config, 10);
  expect(result).not.toBeNull();
  expect(result?.number).toBe(20);
});

test('it finds a linked PR when the body uses "Resolves" keyword', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Resolves #10');

  const result = await getPRForIssue(config, 10);
  expect(result).not.toBeNull();
  expect(result?.number).toBe(20);
});

test('it finds a linked PR when the closing keyword is lowercase', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'closes #10');

  const result = await getPRForIssue(config, 10);
  expect(result).not.toBeNull();
  expect(result?.number).toBe(20);
});

test('it finds a linked PR when the closing keyword is uppercase', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'FIXES #10');

  const result = await getPRForIssue(config, 10);
  expect(result).not.toBeNull();
  expect(result?.number).toBe(20);
});

test('it finds a linked PR when the closing reference is followed by a period', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Fixes things. Closes #10.');

  const result = await getPRForIssue(config, 10);
  expect(result).not.toBeNull();
  expect(result?.number).toBe(20);
});

test('it returns the first matching PR by number when multiple link to the same issue', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      buildPullsListItem({ number: 121, body: 'Also Closes #10', draft: false }),
      buildPullsListItem({ number: 120, body: 'Closes #10', draft: false }),
    ],
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 120,
      title: 'first PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/120',
      head: { sha: 'sha-first', ref: 'pr-120-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.number).toBe(120);
  expect(octokit.pulls.get).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 120,
  });
});

test('it skips pull requests with a null body', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 110, body: null, draft: false })],
  });

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// getPRForIssue — CI status derivation
// ---------------------------------------------------------------------------

test('it reports failure when the combined status is failure', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'failure', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('failure');
});

test('it reports failure when any check run has a failure conclusion', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ],
    },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('failure');
});

test('it reports failure when any check run has a cancelled conclusion', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'cancelled' }],
    },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('failure');
});

test('it reports failure when any check run has a timed out conclusion', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'timed_out' }],
    },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('failure');
});

test('it reports pending when checks have not completed', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'in_progress', conclusion: null }],
    },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('pending');
});

test('it reports pending when the combined status is pending', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('pending');
});

test('it reports pending when no CI is configured', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('pending');
});

test('it reports success when all check runs complete successfully', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 1 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ],
    },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('success');
});

test('it reports success when combined status has no statuses and all check runs succeed', async () => {
  const { octokit, config } = setupTest();
  setupLinkedPr(octokit, 'Closes #10');

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: {
      total_count: 1,
      check_runs: [{ status: 'completed', conclusion: 'success' }],
    },
  });

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('success');
});

test('it defaults to pending when the CI status API call fails', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 100, body: 'Closes #10', draft: false })],
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 100,
      title: 'feat: test',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/100',
      head: { sha: 'sha-error', ref: 'error-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockRejectedValue(new Error('API error'));

  const result = await getPRForIssue(config, 10);
  expect(result?.ciStatus).toBe('pending');
});

test('it propagates API errors when listing pull requests', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockRejectedValue(new Error('Rate limited'));

  await expect(getPRForIssue(config, 10)).rejects.toThrow('Rate limited');
});

// ---------------------------------------------------------------------------
// getPRForIssue — includeDrafts parameter
// ---------------------------------------------------------------------------

test('it excludes draft PRs by default when includeDrafts is not specified', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 30, body: 'Closes #10', draft: true })],
  });

  const result = await getPRForIssue(config, 10);
  expect(result).toBeNull();
});

test('it excludes draft PRs when includeDrafts is false', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 30, body: 'Closes #10', draft: true })],
  });

  const result = await getPRForIssue(config, 10, { includeDrafts: false });
  expect(result).toBeNull();
});

test('it includes draft PRs when includeDrafts is true', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [buildPullsListItem({ number: 30, body: 'Closes #10', draft: true })],
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 30,
      title: 'draft PR',
      changed_files: 2,
      html_url: 'https://github.com/test-owner/test-repo/pull/30',
      head: { sha: 'draft-sha', ref: 'draft-branch' },
      draft: true,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10, { includeDrafts: true });

  expect(result).toStrictEqual({
    number: 30,
    title: 'draft PR',
    changedFilesCount: 2,
    ciStatus: 'pending',
    url: 'https://github.com/test-owner/test-repo/pull/30',
    isDraft: true,
    headRefName: 'draft-branch',
  });
});

test('it returns a non-draft PR when includeDrafts is false and both draft and non-draft PRs exist', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      buildPullsListItem({ number: 41, body: 'Closes #10', draft: true }),
      buildPullsListItem({ number: 40, body: 'Closes #10', draft: false }),
    ],
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 40,
      title: 'non-draft PR',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/40',
      head: { sha: 'non-draft-sha', ref: 'non-draft-branch' },
      draft: false,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'success', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10, { includeDrafts: false });
  expect(result?.number).toBe(40);
  expect(result?.isDraft).toBe(false);
});

test('it returns the first matching PR when includeDrafts is true and both draft and non-draft PRs exist', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.list).mockResolvedValue({
    data: [
      buildPullsListItem({ number: 51, body: 'Closes #10', draft: false }),
      buildPullsListItem({ number: 50, body: 'Closes #10', draft: true }),
    ],
  });

  vi.mocked(octokit.pulls.get).mockResolvedValue({
    data: {
      number: 50,
      title: 'first PR (draft)',
      changed_files: 1,
      html_url: 'https://github.com/test-owner/test-repo/pull/50',
      head: { sha: 'first-sha', ref: 'first-branch' },
      draft: true,
    },
  });

  vi.mocked(octokit.repos.getCombinedStatusForRef).mockResolvedValue({
    data: { state: 'pending', total_count: 0 },
  });

  vi.mocked(octokit.checks.listForRef).mockResolvedValue({
    data: { total_count: 0, check_runs: [] },
  });

  const result = await getPRForIssue(config, 10, { includeDrafts: true });
  expect(result?.number).toBe(50);
  expect(result?.isDraft).toBe(true);
});
