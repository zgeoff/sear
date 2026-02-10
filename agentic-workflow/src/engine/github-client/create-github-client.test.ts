import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { expect, test, vi } from 'vitest';
import { createGitHubClient } from './create-github-client.ts';
import type { GitHubClientConfig } from './types.ts';

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(),
}));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

type MockFn = ReturnType<typeof vi.fn>;

interface MockOctokitShape {
  issues: { get: MockFn; listForRepo: MockFn; addLabels: MockFn; removeLabel: MockFn };
  pulls: { list: MockFn; get: MockFn };
  repos: { getCombinedStatusForRef: MockFn; getContent: MockFn };
  checks: { listForRef: MockFn };
  git: { getTree: MockFn; getRef: MockFn };
}

const mockedOctokit: ReturnType<typeof vi.mocked<typeof Octokit>> = vi.mocked(Octokit);

function setupTest(): {
  client: ReturnType<typeof createGitHubClient>;
  mockOctokit: MockOctokitShape;
  config: GitHubClientConfig;
} {
  const mockOctokit: MockOctokitShape = {
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

  // biome-ignore lint/complexity/useArrowFunction: constructor mock requires function expression for `new`
  mockedOctokit.mockImplementation(function () {
    return mockOctokit;
  });

  const config: GitHubClientConfig = {
    appID: 12_345,
    // biome-ignore lint/security/noSecrets: test fixture with fake credential format
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    installationID: 67_890,
  };

  const client = createGitHubClient(config);

  return { client, mockOctokit, config };
}

// ---------------------------------------------------------------------------
// Factory construction
// ---------------------------------------------------------------------------

test('it creates the client with app auth using the provided credentials', () => {
  // biome-ignore lint/complexity/useArrowFunction: constructor mock requires function expression for `new`
  mockedOctokit.mockImplementation(function () {
    return {};
  });

  const config: GitHubClientConfig = {
    appID: 42,
    privateKey: 'test-key',
    installationID: 99,
  };

  createGitHubClient(config);

  expect(Octokit).toHaveBeenCalledWith({
    authStrategy: createAppAuth,
    auth: {
      appId: 42,
      privateKey: 'test-key',
      installationId: 99,
    },
  });
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

test('it delegates issue retrieval and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.issues.get.mockResolvedValue({
    data: {
      number: 42,
      title: 'Test issue',
      body: 'Issue body',
      labels: [{ name: 'bug' }],
      created_at: '2026-01-01T00:00:00Z',
      extra_field: 'ignored',
    },
  });

  const params = { owner: 'test-owner', repo: 'test-repo', issue_number: 42 };
  const result = await client.issues.get(params);

  expect(mockOctokit.issues.get).toHaveBeenCalledWith(params);
  expect(result.data.number).toBe(42);
  expect(result.data.title).toBe('Test issue');
  expect(result.data.body).toBe('Issue body');
});

test('it coerces undefined issue body to null', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.issues.get.mockResolvedValue({
    data: {
      number: 1,
      title: 'No body',
      body: undefined,
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
    },
  });

  const result = await client.issues.get({ owner: 'o', repo: 'r', issue_number: 1 });

  expect(result.data.body).toBeNull();
});

test('it delegates issue listing and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.issues.listForRepo.mockResolvedValue({
    data: [
      {
        number: 1,
        title: 'First',
        body: 'Body 1',
        labels: ['label-a'],
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        number: 2,
        title: 'Second',
        body: null,
        labels: [],
        created_at: '2026-01-02T00:00:00Z',
      },
    ],
  });

  const params = {
    owner: 'o',
    repo: 'r',
    labels: 'task:implement',
    state: 'open' as const,
    per_page: 100,
  };
  const result = await client.issues.listForRepo(params);

  expect(mockOctokit.issues.listForRepo).toHaveBeenCalledWith(params);
  expect(result.data).toHaveLength(2);
  expect(result.data[0]?.number).toBe(1);
  expect(result.data[1]?.body).toBeNull();
});

test('it delegates adding labels and returns the result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.issues.addLabels.mockResolvedValue({ data: { id: 1 } });

  const params = { owner: 'o', repo: 'r', issue_number: 1, labels: ['bug'] };
  const result = await client.issues.addLabels(params);

  expect(mockOctokit.issues.addLabels).toHaveBeenCalledWith(params);
  expect(result.data).toStrictEqual({ id: 1 });
});

test('it delegates removing a label and returns the result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.issues.removeLabel.mockResolvedValue({ data: [] });

  const params = { owner: 'o', repo: 'r', issue_number: 1, name: 'bug' };
  const result = await client.issues.removeLabel(params);

  expect(mockOctokit.issues.removeLabel).toHaveBeenCalledWith(params);
  expect(result.data).toStrictEqual([]);
});

// ---------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------

test('it delegates pull request listing and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.pulls.list.mockResolvedValue({
    data: [
      { number: 10, body: 'Closes #1' },
      { number: 11, body: null },
    ],
  });

  const params = { owner: 'o', repo: 'r', state: 'open' as const, per_page: 100 };
  const result = await client.pulls.list(params);

  expect(mockOctokit.pulls.list).toHaveBeenCalledWith(params);
  expect(result.data).toHaveLength(2);
  expect(result.data[0]?.number).toBe(10);
  expect(result.data[0]?.body).toBe('Closes #1');
  expect(result.data[1]?.body).toBeNull();
});

test('it delegates pull request retrieval and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.pulls.get.mockResolvedValue({
    data: {
      number: 10,
      title: 'Fix bug',
      changed_files: 3,
      html_url: 'https://github.com/o/r/pull/10',
      head: { sha: 'abc123', ref: 'feature-branch' },
    },
  });

  const params = { owner: 'o', repo: 'r', pull_number: 10 };
  const result = await client.pulls.get(params);

  expect(mockOctokit.pulls.get).toHaveBeenCalledWith(params);
  expect(result.data.number).toBe(10);
  expect(result.data.title).toBe('Fix bug');
  expect(result.data.changed_files).toBe(3);
  expect(result.data.head.sha).toBe('abc123');
});

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

test('it delegates combined status retrieval and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.repos.getCombinedStatusForRef.mockResolvedValue({
    data: { state: 'success', total_count: 2 },
  });

  const params = { owner: 'o', repo: 'r', ref: 'abc123' };
  const result = await client.repos.getCombinedStatusForRef(params);

  expect(mockOctokit.repos.getCombinedStatusForRef).toHaveBeenCalledWith(params);
  expect(result.data.state).toBe('success');
  expect(result.data.total_count).toBe(2);
});

test('it delegates content retrieval and returns the content field', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.repos.getContent.mockResolvedValue({
    data: { content: 'base64content', encoding: 'base64', type: 'file' },
  });

  const params = { owner: 'o', repo: 'r', path: 'docs/spec.md', ref: 'main' };
  const result = await client.repos.getContent(params);

  expect(mockOctokit.repos.getContent).toHaveBeenCalledWith(params);
  expect(result.data.content).toBe('base64content');
});

test('it returns an empty data object when content is not present in the response', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.repos.getContent.mockResolvedValue({
    data: [{ name: 'file.md' }],
  });

  const result = await client.repos.getContent({
    owner: 'o',
    repo: 'r',
    path: 'docs/',
    ref: 'main',
  });

  expect(result.data.content).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

test('it delegates check runs listing and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.checks.listForRef.mockResolvedValue({
    data: {
      total_count: 2,
      check_runs: [
        { status: 'completed', conclusion: 'success', name: 'CI' },
        { status: 'in_progress', conclusion: null, name: 'Lint' },
      ],
    },
  });

  const params = { owner: 'o', repo: 'r', ref: 'abc123' };
  const result = await client.checks.listForRef(params);

  expect(mockOctokit.checks.listForRef).toHaveBeenCalledWith(params);
  expect(result.data.total_count).toBe(2);
  expect(result.data.check_runs).toHaveLength(2);
  expect(result.data.check_runs[0]?.status).toBe('completed');
  expect(result.data.check_runs[0]?.conclusion).toBe('success');
  expect(result.data.check_runs[1]?.conclusion).toBeNull();
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

test('it delegates tree retrieval and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.git.getTree.mockResolvedValue({
    data: {
      sha: 'tree-sha-1',
      tree: [
        { path: 'docs/spec.md', sha: 'file-sha-1', type: 'blob', size: 1024 },
        { path: 'src', sha: 'dir-sha-1', type: 'tree' },
      ],
      truncated: false,
    },
  });

  const params = { owner: 'o', repo: 'r', tree_sha: 'tree-sha-1', recursive: '1' };
  const result = await client.git.getTree(params);

  expect(mockOctokit.git.getTree).toHaveBeenCalledWith(params);
  expect(result.data.sha).toBe('tree-sha-1');
  expect(result.data.tree).toHaveLength(2);
  expect(result.data.tree[0]?.path).toBe('docs/spec.md');
  expect(result.data.tree[1]?.type).toBe('tree');
});

test('it delegates ref retrieval and returns the narrowed result', async () => {
  const { client, mockOctokit } = setupTest();

  mockOctokit.git.getRef.mockResolvedValue({
    data: {
      ref: 'refs/heads/main',
      object: { sha: 'commit-sha-1', type: 'commit' },
    },
  });

  const params = { owner: 'o', repo: 'r', ref: 'heads/main' };
  const result = await client.git.getRef(params);

  expect(mockOctokit.git.getRef).toHaveBeenCalledWith(params);
  expect(result.data.object.sha).toBe('commit-sha-1');
});

// ---------------------------------------------------------------------------
// Error propagation
// ---------------------------------------------------------------------------

test('it propagates errors from the underlying client without modification', async () => {
  const { client, mockOctokit } = setupTest();

  const originalError = new Error('GitHub API rate limited');
  mockOctokit.issues.get.mockRejectedValue(originalError);

  const error = await client.issues.get({ owner: 'o', repo: 'r', issue_number: 1 }).catch((e) => e);

  expect(error).toBe(originalError);
});
