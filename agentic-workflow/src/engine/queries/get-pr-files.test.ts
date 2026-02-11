import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import { getPRFiles } from './get-pr-files.ts';
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
// getPRFiles — basic file listing
// ---------------------------------------------------------------------------

test('it returns normalized file entries when the PR has changed files', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'src/main.ts',
        status: 'modified',
        patch: '@@ -1,3 +1,4 @@\n-old line\n+new line',
      },
      {
        filename: 'src/utils.ts',
        status: 'added',
        patch: '@@ -0,0 +1,5 @@\n+export function util() {}',
      },
      {
        filename: 'README.md',
        status: 'modified',
        patch: '@@ -5,2 +5,2 @@\n-old readme\n+new readme',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result).toStrictEqual([
    {
      filename: 'src/main.ts',
      status: 'modified',
      patch: '@@ -1,3 +1,4 @@\n-old line\n+new line',
    },
    {
      filename: 'src/utils.ts',
      status: 'added',
      patch: '@@ -0,0 +1,5 @@\n+export function util() {}',
    },
    {
      filename: 'README.md',
      status: 'modified',
      patch: '@@ -5,2 +5,2 @@\n-old readme\n+new readme',
    },
  ]);
});

test('it returns an empty array when the PR has no changed files', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [],
  });

  const result = await getPRFiles(config, 42);

  expect(result).toStrictEqual([]);
});

// ---------------------------------------------------------------------------
// getPRFiles — binary files and missing patches
// ---------------------------------------------------------------------------

test('it includes entries with no patch field for binary files', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'image.png',
        status: 'added',
      },
      {
        filename: 'src/code.ts',
        status: 'modified',
        patch: '@@ -1,2 +1,2 @@\n-old\n+new',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result).toStrictEqual([
    {
      filename: 'image.png',
      status: 'added',
    },
    {
      filename: 'src/code.ts',
      status: 'modified',
      patch: '@@ -1,2 +1,2 @@\n-old\n+new',
    },
  ]);
});

test('it includes entries with no patch field for files exceeding diff size limit', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'large-file.txt',
        status: 'modified',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result).toStrictEqual([
    {
      filename: 'large-file.txt',
      status: 'modified',
    },
  ]);
});

// ---------------------------------------------------------------------------
// getPRFiles — status normalization
// ---------------------------------------------------------------------------

test('it normalizes the added status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'new-file.ts',
        status: 'added',
        patch: '@@ -0,0 +1 @@\n+content',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('added');
});

test('it normalizes the modified status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'existing.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('modified');
});

test('it normalizes the removed status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'deleted.ts',
        status: 'removed',
        patch: '@@ -1 +0,0 @@\n-deleted content',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('removed');
});

test('it normalizes the renamed status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'new-name.ts',
        status: 'renamed',
        patch: '@@ -1 +1 @@\n content',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('renamed');
});

test('it normalizes the copied status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'copy.ts',
        status: 'copied',
        patch: '@@ -0,0 +1 @@\n+content',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('copied');
});

test('it normalizes the changed status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'changed.ts',
        status: 'changed',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('changed');
});

test('it normalizes the unchanged status', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'unchanged.ts',
        status: 'unchanged',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('unchanged');
});

test('it defaults to changed for unrecognized status values', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [
      {
        filename: 'unknown.ts',
        status: 'unknown-status',
        patch: '@@ -1 +1 @@\n-old\n+new',
      },
    ],
  });

  const result = await getPRFiles(config, 42);

  expect(result[0]?.status).toBe('changed');
});

// ---------------------------------------------------------------------------
// getPRFiles — API call parameters
// ---------------------------------------------------------------------------

test('it calls listFiles with per_page set to 100', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockResolvedValue({
    data: [],
  });

  await getPRFiles(config, 42);

  expect(octokit.pulls.listFiles).toHaveBeenCalledWith({
    owner: 'test-owner',
    repo: 'test-repo',
    pull_number: 42,
    per_page: 100,
  });
});

test('it propagates API errors when listing files fails', async () => {
  const { octokit, config } = setupTest();

  vi.mocked(octokit.pulls.listFiles).mockRejectedValue(new Error('API rate limit exceeded'));

  await expect(getPRFiles(config, 42)).rejects.toThrow('API rate limit exceeded');
});
