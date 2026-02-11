import { expect, test, vi } from 'vitest';
import type { GitHubClient } from '../github-client/types.ts';
import { getPRReviews } from './get-pr-reviews.ts';
import type { QueriesConfig } from './types.ts';

interface SetupTestResult {
  mockOctokit: GitHubClient;
  config: QueriesConfig;
}

function setupTest(): SetupTestResult {
  const mockOctokit: GitHubClient = {
    issues: {} as GitHubClient['issues'],
    pulls: {
      list: vi.fn(),
      get: vi.fn(),
      listFiles: vi.fn(),
      listReviews: vi.fn(),
      listReviewComments: vi.fn(),
    },
    repos: {} as GitHubClient['repos'],
    checks: {} as GitHubClient['checks'],
    git: {} as GitHubClient['git'],
  };

  const config: QueriesConfig = {
    octokit: mockOctokit,
    owner: 'test-owner',
    repo: 'test-repo',
  };

  return { mockOctokit, config };
}

test('it returns reviews and comments in separate arrays when both exist', async () => {
  const { mockOctokit, config } = setupTest();

  const mockReviews = [
    {
      id: 1,
      user: { login: 'reviewer1' },
      state: 'APPROVED',
      body: 'Looks good!',
    },
    {
      id: 2,
      user: { login: 'reviewer2' },
      state: 'CHANGES_REQUESTED',
      body: 'Please fix',
    },
  ];

  const mockComments = [
    {
      id: 10,
      user: { login: 'commenter1' },
      body: 'Inline comment 1',
      path: 'src/file.ts',
      line: 42,
    },
    {
      id: 11,
      user: { login: 'commenter2' },
      body: 'Inline comment 2',
      path: 'src/other.ts',
      line: 100,
    },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: mockReviews,
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: mockComments,
  });

  const result = await getPRReviews(config, 123);

  expect(mockOctokit.pulls.listReviews).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 123,
    per_page: 100,
  });

  expect(mockOctokit.pulls.listReviewComments).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 123,
    per_page: 100,
  });

  expect(result.reviews).toStrictEqual([
    {
      id: 1,
      author: 'reviewer1',
      state: 'APPROVED',
      body: 'Looks good!',
    },
    {
      id: 2,
      author: 'reviewer2',
      state: 'CHANGES_REQUESTED',
      body: 'Please fix',
    },
  ]);

  expect(result.comments).toStrictEqual([
    {
      id: 10,
      author: 'commenter1',
      body: 'Inline comment 1',
      path: 'src/file.ts',
      line: 42,
    },
    {
      id: 11,
      author: 'commenter2',
      body: 'Inline comment 2',
      path: 'src/other.ts',
      line: 100,
    },
  ]);
});

test('it returns empty arrays when no reviews or comments exist', async () => {
  const { mockOctokit, config } = setupTest();

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: [],
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: [],
  });

  const result = await getPRReviews(config, 123);

  expect(result).toStrictEqual({
    reviews: [],
    comments: [],
  });
});

test('it converts null review body to empty string', async () => {
  const { mockOctokit, config } = setupTest();

  const mockReviews = [
    {
      id: 1,
      user: { login: 'reviewer1' },
      state: 'APPROVED',
      body: null,
    },
    {
      id: 2,
      user: { login: 'reviewer2' },
      state: 'COMMENTED',
      body: 'Valid comment',
    },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: mockReviews,
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: [],
  });

  const result = await getPRReviews(config, 123);

  expect(result.reviews).toStrictEqual([
    {
      id: 1,
      author: 'reviewer1',
      state: 'APPROVED',
      body: '',
    },
    {
      id: 2,
      author: 'reviewer2',
      state: 'COMMENTED',
      body: 'Valid comment',
    },
  ]);
});

test('it converts null user to empty string author', async () => {
  const { mockOctokit, config } = setupTest();

  const mockReviews = [
    {
      id: 1,
      user: null,
      state: 'APPROVED',
      body: 'Looks good',
    },
    {
      id: 2,
      user: { login: 'reviewer2' },
      state: 'CHANGES_REQUESTED',
      body: 'Please fix',
    },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: mockReviews,
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: [],
  });

  const result = await getPRReviews(config, 123);

  expect(result.reviews).toStrictEqual([
    {
      id: 1,
      author: '',
      state: 'APPROVED',
      body: 'Looks good',
    },
    {
      id: 2,
      author: 'reviewer2',
      state: 'CHANGES_REQUESTED',
      body: 'Please fix',
    },
  ]);
});

test('it preserves null line for outdated comments', async () => {
  const { mockOctokit, config } = setupTest();

  const mockComments = [
    {
      id: 10,
      user: { login: 'commenter1' },
      body: 'Outdated comment',
      path: 'src/file.ts',
      line: null,
    },
    {
      id: 11,
      user: { login: 'commenter2' },
      body: 'Current comment',
      path: 'src/other.ts',
      line: 50,
    },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: [],
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: mockComments,
  });

  const result = await getPRReviews(config, 123);

  expect(result.comments).toStrictEqual([
    {
      id: 10,
      author: 'commenter1',
      body: 'Outdated comment',
      path: 'src/file.ts',
      line: null,
    },
    {
      id: 11,
      author: 'commenter2',
      body: 'Current comment',
      path: 'src/other.ts',
      line: 50,
    },
  ]);
});

test('it converts null comment body to empty string', async () => {
  const { mockOctokit, config } = setupTest();

  const mockComments = [
    {
      id: 10,
      user: { login: 'commenter1' },
      body: null,
      path: 'src/file.ts',
      line: 42,
    },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: [],
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: mockComments,
  });

  const result = await getPRReviews(config, 123);

  expect(result.comments).toStrictEqual([
    {
      id: 10,
      author: 'commenter1',
      body: '',
      path: 'src/file.ts',
      line: 42,
    },
  ]);
});

test('it converts null user to empty string author in comments', async () => {
  const { mockOctokit, config } = setupTest();

  const mockComments = [
    {
      id: 10,
      user: null,
      body: 'Comment from deleted user',
      path: 'src/file.ts',
      line: 42,
    },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: [],
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: mockComments,
  });

  const result = await getPRReviews(config, 123);

  expect(result.comments).toStrictEqual([
    {
      id: 10,
      author: '',
      body: 'Comment from deleted user',
      path: 'src/file.ts',
      line: 42,
    },
  ]);
});

test('it calls both GitHub APIs in parallel', async () => {
  const { mockOctokit, config } = setupTest();

  const listReviewsPromise = Promise.resolve({ data: [] });
  const listReviewCommentsPromise = Promise.resolve({ data: [] });

  mockOctokit.pulls.listReviews = vi.fn().mockReturnValue(listReviewsPromise);
  mockOctokit.pulls.listReviewComments = vi.fn().mockReturnValue(listReviewCommentsPromise);

  const resultPromise = getPRReviews(config, 123);

  await Promise.resolve();

  expect(mockOctokit.pulls.listReviews).toHaveBeenCalled();
  expect(mockOctokit.pulls.listReviewComments).toHaveBeenCalled();

  await resultPromise;
});

test('it preserves API order for reviews', async () => {
  const { mockOctokit, config } = setupTest();

  const mockReviews = [
    { id: 3, user: { login: 'user1' }, state: 'APPROVED', body: 'Third' },
    { id: 1, user: { login: 'user2' }, state: 'COMMENTED', body: 'First' },
    { id: 2, user: { login: 'user3' }, state: 'CHANGES_REQUESTED', body: 'Second' },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: mockReviews,
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: [],
  });

  const result = await getPRReviews(config, 123);

  expect(result.reviews[0]?.id).toBe(3);
  expect(result.reviews[1]?.id).toBe(1);
  expect(result.reviews[2]?.id).toBe(2);
});

test('it preserves API order for comments', async () => {
  const { mockOctokit, config } = setupTest();

  const mockComments = [
    { id: 30, user: { login: 'user1' }, body: 'Third', path: 'a.ts', line: 1 },
    { id: 10, user: { login: 'user2' }, body: 'First', path: 'b.ts', line: 2 },
    { id: 20, user: { login: 'user3' }, body: 'Second', path: 'c.ts', line: 3 },
  ];

  mockOctokit.pulls.listReviews = vi.fn().mockResolvedValue({
    data: [],
  });

  mockOctokit.pulls.listReviewComments = vi.fn().mockResolvedValue({
    data: mockComments,
  });

  const result = await getPRReviews(config, 123);

  expect(result.comments[0]?.id).toBe(30);
  expect(result.comments[1]?.id).toBe(10);
  expect(result.comments[2]?.id).toBe(20);
});
