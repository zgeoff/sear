import { expect, test, vi } from 'vitest';
import { createMockGitHubClient } from '../../test-utils/create-mock-github-client.ts';
import type { GitHubClient } from '../github-client/types.ts';
import { createSpecPoller } from './create-spec-poller.ts';
import type { LogError, SpecPollerSnapshot } from './types.ts';

// ---------------------------------------------------------------------------
// Mock GitHub client factory (builds on shared createMockGitHubClient)
// ---------------------------------------------------------------------------

interface TreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree';
}

interface MockGetTreeParams {
  tree_sha: string;
  recursive?: string;
}

interface MockGetTreeResult {
  data: { sha: string; tree: TreeEntry[] };
}

interface MockGetContentParams {
  path: string;
  ref?: string;
}

interface MockGetContentResult {
  data: { content?: string };
}

interface MockGetRefParams {
  ref: string;
}

interface MockGetRefResult {
  data: { object: { sha: string } };
}

interface MockHandlers {
  getTree: (params: MockGetTreeParams) => MockGetTreeResult;
  getContent: (params: MockGetContentParams) => MockGetContentResult;
  getRef: (params: MockGetRefParams) => MockGetRefResult;
}

function buildMockClient(handlers: Partial<MockHandlers> = {}): GitHubClient {
  const client = createMockGitHubClient();

  vi.mocked(client.git.getTree).mockImplementation((params) => {
    if (handlers.getTree && params) {
      return Promise.resolve(handlers.getTree(params));
    }
    return Promise.resolve({ data: { sha: '', tree: [] } });
  });

  vi.mocked(client.git.getRef).mockImplementation((params) => {
    if (handlers.getRef && params) {
      return Promise.resolve(handlers.getRef(params));
    }
    return Promise.resolve({ data: { object: { sha: 'head-commit-sha' } } });
  });

  vi.mocked(client.repos.getContent).mockImplementation((params) => {
    if (handlers.getContent && params) {
      return Promise.resolve().then(() => handlers.getContent(params));
    }
    return Promise.resolve({ data: {} });
  });

  return client;
}

// ---------------------------------------------------------------------------
// Spec content helpers
// ---------------------------------------------------------------------------

function buildSpecContent(status: string): string {
  return `---\ntitle: Test Spec\nversion: 0.1.0\nstatus: ${status}\n---\n\n# Test Spec\n\nContent here.\n`;
}

function toBase64(content: string): string {
  return Buffer.from(content).toString('base64');
}

// ---------------------------------------------------------------------------
// Default setup helper
// ---------------------------------------------------------------------------

interface SetupOptions {
  handlers?: Partial<MockHandlers>;
  specsDir?: string;
  defaultBranch?: string;
  logError?: LogError;
  initialSnapshot?: SpecPollerSnapshot;
}

function setupTest(options: SetupOptions = {}): {
  octokit: GitHubClient;
  poller: ReturnType<typeof createSpecPoller>;
} {
  const octokit = buildMockClient(options.handlers);
  const logError = options.logError ?? vi.fn();
  const poller = createSpecPoller({
    octokit,
    owner: 'test-owner',
    repo: 'test-repo',
    specsDir: options.specsDir ?? 'docs/specs/',
    defaultBranch: options.defaultBranch ?? 'main',
    logError,
    ...(options.initialSnapshot ? { initialSnapshot: options.initialSnapshot } : {}),
  });
  return { octokit, poller };
}

// ---------------------------------------------------------------------------
// Tree handler builder
// ---------------------------------------------------------------------------

function buildTreeHandlers(
  specsDirTreeSha: string,
  specFiles: TreeEntry[],
): { getTree: (params: MockGetTreeParams) => MockGetTreeResult } {
  return {
    getTree: (params: { tree_sha: string; recursive?: string }): MockGetTreeResult => {
      // Root recursive tree (branch name) -- includes specs dir entry
      if (params.tree_sha === 'main') {
        return {
          data: {
            sha: 'root-tree-sha',
            tree: [
              { path: 'docs', sha: 'docs-tree-sha', type: 'tree' as const },
              { path: 'docs/specs', sha: specsDirTreeSha, type: 'tree' as const },
            ],
          },
        };
      }
      // Specs subtree (recursive fetch for change detection)
      if (params.tree_sha === specsDirTreeSha) {
        return {
          data: {
            sha: specsDirTreeSha,
            tree: specFiles,
          },
        };
      }
      return { data: { sha: '', tree: [] } };
    },
  };
}

// ---------------------------------------------------------------------------
// SpecPoller — single API call for tree SHA
// ---------------------------------------------------------------------------

test('it fetches the specs directory tree SHA with a single recursive API call', async () => {
  const specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });
  await poller.poll();

  const firstCall = vi.mocked(octokit.git.getTree).mock.calls[0];
  expect(firstCall?.[0]).toEqual(expect.objectContaining({ tree_sha: 'main', recursive: 'true' }));
});

// ---------------------------------------------------------------------------
// SpecPoller — tree SHA unchanged (no further API calls)
// ---------------------------------------------------------------------------

test('it returns an empty result and skips content calls when the tree SHA is unchanged', async () => {
  const specFiles = [{ path: 'workflow/engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-abc' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });

  // First poll -- populates snapshot
  await poller.poll();

  vi.mocked(octokit.git.getTree).mockClear();
  vi.mocked(octokit.repos.getContent).mockClear();
  vi.mocked(octokit.git.getRef).mockClear();

  // Second poll -- same tree SHA, should short-circuit after single getTree call
  const result = await poller.poll();

  expect(result.changes).toHaveLength(0);
  expect(result.commitSHA).toBe('');

  // Only the root recursive tree call to check tree SHA -- no subtree or content calls
  expect(octokit.git.getTree).toHaveBeenCalledTimes(1);
  expect(octokit.repos.getContent).not.toHaveBeenCalled();
  expect(octokit.git.getRef).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// SpecPoller — detects new files
// ---------------------------------------------------------------------------

test('it detects new spec files and returns their frontmatter status', async () => {
  const specFiles = [
    { path: 'workflow/engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'workflow/tui.md', sha: 'blob-sha-2', type: 'blob' as const },
  ];

  const contentMap: Record<string, string> = {
    'docs/specs/workflow/engine.md': buildSpecContent('approved'),
    'docs/specs/workflow/tui.md': buildSpecContent('draft'),
  };

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: (params: { path: string }) => ({
      data: { content: toBase64(contentMap[params.path] ?? '') },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-abc123' } } }),
  };

  const { poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(2);
  expect(result.changes).toContainEqual({
    filePath: 'docs/specs/workflow/engine.md',
    frontmatterStatus: 'approved',
  });
  expect(result.changes).toContainEqual({
    filePath: 'docs/specs/workflow/tui.md',
    frontmatterStatus: 'draft',
  });
  expect(result.commitSHA).toBe('commit-abc123');
});

// ---------------------------------------------------------------------------
// SpecPoller — detects modified files
// ---------------------------------------------------------------------------

test('it detects modified files when the blob SHA changes between polls', async () => {
  let specsDirTreeSha = 'specs-tree-sha-1';
  let specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];
  let engineContent = buildSpecContent('draft');

  const handlers = {
    getTree: (params: { tree_sha: string; recursive?: string }) => {
      if (params.tree_sha === 'main') {
        return {
          data: {
            sha: 'root-sha',
            tree: [
              { path: 'docs', sha: 'docs-sha', type: 'tree' as const },
              { path: 'docs/specs', sha: specsDirTreeSha, type: 'tree' as const },
            ],
          },
        };
      }
      return { data: { sha: specsDirTreeSha, tree: specFiles } };
    },
    getContent: () => ({
      data: { content: toBase64(engineContent) },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const { poller } = setupTest({ handlers });

  // First poll: detects new file with draft status
  const result1 = await poller.poll();
  expect(result1.changes).toHaveLength(1);
  expect(result1.changes[0]?.frontmatterStatus).toBe('draft');

  // Simulate file modification: new blob SHA, new tree SHA, new content
  specsDirTreeSha = 'specs-tree-sha-2';
  specFiles = [{ path: 'engine.md', sha: 'blob-sha-2', type: 'blob' as const }];
  engineContent = buildSpecContent('approved');

  // Second poll: detects the modification
  const result2 = await poller.poll();
  expect(result2.changes).toHaveLength(1);
  expect(result2.changes[0]?.frontmatterStatus).toBe('approved');
  expect(result2.commitSHA).toBe('head-sha');
});

// ---------------------------------------------------------------------------
// SpecPoller — detects removed files
// ---------------------------------------------------------------------------

test('it removes deleted files from the snapshot without including them in the result', async () => {
  let specsDirTreeSha = 'specs-tree-sha-1';
  let specFiles: TreeEntry[] = [
    { path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'tui.md', sha: 'blob-sha-2', type: 'blob' as const },
  ];

  const contentMap: Record<string, string> = {
    'docs/specs/engine.md': buildSpecContent('approved'),
    'docs/specs/tui.md': buildSpecContent('draft'),
  };

  const handlers = {
    getTree: (params: { tree_sha: string; recursive?: string }) => {
      if (params.tree_sha === 'main') {
        return {
          data: {
            sha: 'root-sha',
            tree: [
              { path: 'docs', sha: 'docs-sha', type: 'tree' as const },
              { path: 'docs/specs', sha: specsDirTreeSha, type: 'tree' as const },
            ],
          },
        };
      }
      return { data: { sha: specsDirTreeSha, tree: specFiles } };
    },
    getContent: (params: { path: string }) => ({
      data: { content: toBase64(contentMap[params.path] ?? '') },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const { poller } = setupTest({ handlers });

  // First poll: detect both files
  const result1 = await poller.poll();
  expect(result1.changes).toHaveLength(2);

  // Remove tui.md from tree
  specsDirTreeSha = 'specs-tree-sha-2';
  specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  // Second poll: tree changed but engine.md blob SHA is same, tui.md removed
  const result2 = await poller.poll();
  expect(result2.changes).toHaveLength(0);

  // Verify: adding tui.md back as new should detect it again
  specsDirTreeSha = 'specs-tree-sha-3';
  specFiles = [
    { path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'tui.md', sha: 'blob-sha-3', type: 'blob' as const },
  ];

  const result3 = await poller.poll();
  expect(result3.changes).toHaveLength(1);
  expect(result3.changes[0]?.filePath).toBe('docs/specs/tui.md');
});

// ---------------------------------------------------------------------------
// SpecPoller — GitHub API error returns empty result
// ---------------------------------------------------------------------------

test('it returns an empty result on GitHub API error without crashing', async () => {
  const logError = vi.fn();
  const client = createMockGitHubClient();
  vi.mocked(client.git.getTree).mockRejectedValue(new Error('GitHub API rate limit exceeded'));

  const poller = createSpecPoller({
    octokit: client,
    owner: 'test-owner',
    repo: 'test-repo',
    specsDir: 'docs/specs/',
    defaultBranch: 'main',
    logError,
  });

  const result = await poller.poll();
  expect(result.changes).toHaveLength(0);
  expect(result.commitSHA).toBe('');
});

// ---------------------------------------------------------------------------
// SpecPoller — specs directory not found
// ---------------------------------------------------------------------------

test('it returns an empty result when the specs directory does not exist in the tree', async () => {
  const handlers = {
    getTree: () => ({
      data: {
        sha: 'root-sha',
        tree: [{ path: 'src', sha: 'src-sha', type: 'tree' as const }],
      },
    }),
  };

  const { poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(0);
  expect(result.commitSHA).toBe('');
});

// ---------------------------------------------------------------------------
// SpecPoller — HEAD commit SHA fetched only for changed cycles
// ---------------------------------------------------------------------------

test('it fetches the HEAD commit SHA only when changes are detected', async () => {
  const specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  // File has no parseable frontmatter -- will be skipped
  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: { content: toBase64('# No frontmatter\n\nJust content.') },
    }),
    getRef: () => ({ data: { object: { sha: 'should-not-be-fetched' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(0);
  expect(result.commitSHA).toBe('');
  expect(octokit.git.getRef).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// SpecPoller — file content fetch failure skips file
// ---------------------------------------------------------------------------

test('it skips files whose content fetch fails and continues with others', async () => {
  const specFiles = [
    { path: 'good.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'bad.md', sha: 'blob-sha-2', type: 'blob' as const },
  ];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: (params: { path: string }) => {
      if (params.path === 'docs/specs/bad.md') {
        throw new Error('Not found');
      }
      return {
        data: { content: toBase64(buildSpecContent('approved')) },
      };
    },
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]?.filePath).toBe('docs/specs/good.md');
  expect(result.commitSHA).toBe('commit-sha');
});

// ---------------------------------------------------------------------------
// SpecPoller — unchanged blob SHA skips content fetch
// ---------------------------------------------------------------------------

test('it does not fetch content for files with unchanged blob SHA', async () => {
  let specsDirTreeSha = 'specs-tree-sha-1';
  let specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    getTree: (params: { tree_sha: string; recursive?: string }) => {
      if (params.tree_sha === 'main') {
        return {
          data: {
            sha: 'root-sha',
            tree: [
              { path: 'docs', sha: 'docs-sha', type: 'tree' as const },
              { path: 'docs/specs', sha: specsDirTreeSha, type: 'tree' as const },
            ],
          },
        };
      }
      return { data: { sha: specsDirTreeSha, tree: specFiles } };
    },
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });

  // First poll: detects new file
  await poller.poll();

  // Change tree SHA but keep same blob SHA for engine.md, add a new file
  specsDirTreeSha = 'specs-tree-sha-2';
  specFiles = [
    { path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'tui.md', sha: 'blob-sha-new', type: 'blob' as const },
  ];

  vi.mocked(octokit.repos.getContent).mockClear();

  // Second poll: engine.md unchanged (same blob SHA), only tui.md is fetched
  const result = await poller.poll();

  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]?.filePath).toBe('docs/specs/tui.md');

  // getContent should only be called for the new file, not unchanged engine.md
  expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  expect(octokit.repos.getContent).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'docs/specs/tui.md' }),
  );
});

// ---------------------------------------------------------------------------
// SpecPoller — first poll with empty snapshot
// ---------------------------------------------------------------------------

test('it treats the first poll cycle as all files being new', async () => {
  const specFiles = [
    { path: 'a.md', sha: 'sha-a', type: 'blob' as const },
    { path: 'b.md', sha: 'sha-b', type: 'blob' as const },
    { path: 'c.md', sha: 'sha-c', type: 'blob' as const },
  ];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'initial-commit' } } }),
  };

  const { poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(3);
  expect(result.commitSHA).toBe('initial-commit');
});

// ---------------------------------------------------------------------------
// SpecPoller — tree entries of type 'tree' (subdirectories) are ignored
// ---------------------------------------------------------------------------

test('it ignores tree entries that are not blobs', async () => {
  const specFiles: TreeEntry[] = [
    { path: 'workflow', sha: 'subdir-sha', type: 'tree' },
    { path: 'workflow/engine.md', sha: 'blob-sha-1', type: 'blob' },
  ];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]?.filePath).toBe('docs/specs/workflow/engine.md');
});

// ---------------------------------------------------------------------------
// SpecPoller — getSnapshot() returns empty snapshot initially
// ---------------------------------------------------------------------------

test('it returns an empty snapshot when no seed is provided and no polls have run', () => {
  const { poller } = setupTest();
  const snap = poller.getSnapshot();

  expect(snap).toStrictEqual({
    specsDirTreeSHA: null,
    files: {},
  });
});

// ---------------------------------------------------------------------------
// SpecPoller — getSnapshot() returns seeded snapshot
// ---------------------------------------------------------------------------

test('it returns the seeded snapshot when an initial snapshot is provided', () => {
  const initialSnapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: 'seeded-tree-sha',
    files: {
      'docs/specs/engine.md': { blobSHA: 'blob-1', frontmatterStatus: 'approved' },
      'docs/specs/tui.md': { blobSHA: 'blob-2', frontmatterStatus: 'draft' },
    },
  };

  const { poller } = setupTest({ initialSnapshot });
  const snap = poller.getSnapshot();

  expect(snap).toStrictEqual(initialSnapshot);
});

// ---------------------------------------------------------------------------
// SpecPoller — seeded tree SHA matches current yields empty batch
// ---------------------------------------------------------------------------

test('it returns an empty batch on first poll when the seeded tree SHA matches the current one', async () => {
  const specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    ...buildTreeHandlers('seeded-tree-sha', specFiles),
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const initialSnapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: 'seeded-tree-sha',
    files: {
      'docs/specs/engine.md': { blobSHA: 'blob-sha-1', frontmatterStatus: 'approved' },
    },
  };

  const { octokit, poller } = setupTest({ handlers, initialSnapshot });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(0);
  expect(result.commitSHA).toBe('');
  // Only the root tree call to check tree SHA -- no subtree or content calls needed
  expect(octokit.git.getTree).toHaveBeenCalledTimes(1);
  expect(octokit.repos.getContent).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// SpecPoller — seeded tree SHA differs, only changed files reported
// ---------------------------------------------------------------------------

test('it reports only files with changed blob SHAs when the seeded tree SHA differs', async () => {
  const specFiles = [
    { path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'tui.md', sha: 'blob-sha-new', type: 'blob' as const },
  ];

  const contentMap: Record<string, string> = {
    'docs/specs/engine.md': buildSpecContent('approved'),
    'docs/specs/tui.md': buildSpecContent('draft'),
  };

  const handlers = {
    ...buildTreeHandlers('current-tree-sha', specFiles),
    getContent: (params: { path: string }) => ({
      data: { content: toBase64(contentMap[params.path] ?? '') },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const initialSnapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: 'old-tree-sha',
    files: {
      'docs/specs/engine.md': { blobSHA: 'blob-sha-1', frontmatterStatus: 'approved' },
      'docs/specs/tui.md': { blobSHA: 'blob-sha-old', frontmatterStatus: 'draft' },
    },
  };

  const { octokit, poller } = setupTest({ handlers, initialSnapshot });
  const result = await poller.poll();

  // Only tui.md changed (blob SHA differs), engine.md unchanged
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toStrictEqual({
    filePath: 'docs/specs/tui.md',
    frontmatterStatus: 'draft',
  });
  expect(result.commitSHA).toBe('head-sha');

  // Content should only be fetched for the changed file
  expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  expect(octokit.repos.getContent).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'docs/specs/tui.md' }),
  );
});

// ---------------------------------------------------------------------------
// SpecPoller — getSnapshot() reflects state after a poll cycle
// ---------------------------------------------------------------------------

test('it returns an updated snapshot after a poll cycle completes', async () => {
  const specFiles = [
    { path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'tui.md', sha: 'blob-sha-2', type: 'blob' as const },
  ];

  const contentMap: Record<string, string> = {
    'docs/specs/engine.md': buildSpecContent('approved'),
    'docs/specs/tui.md': buildSpecContent('draft'),
  };

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: (params: { path: string }) => ({
      data: { content: toBase64(contentMap[params.path] ?? '') },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { poller } = setupTest({ handlers });
  await poller.poll();

  const snap = poller.getSnapshot();
  expect(snap).toStrictEqual({
    specsDirTreeSHA: 'specs-tree-sha-1',
    files: {
      'docs/specs/engine.md': { blobSHA: 'blob-sha-1', frontmatterStatus: 'approved' },
      'docs/specs/tui.md': { blobSHA: 'blob-sha-2', frontmatterStatus: 'draft' },
    },
  });
});

// ---------------------------------------------------------------------------
// SpecPoller — getSnapshot() returns a fresh copy
// ---------------------------------------------------------------------------

test('it returns a fresh copy of the snapshot that does not affect internal state when mutated', async () => {
  const specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: { content: toBase64(buildSpecContent('approved')) },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { poller } = setupTest({ handlers });
  await poller.poll();

  // Get snapshot and mutate it
  const snap1 = poller.getSnapshot();
  snap1.specsDirTreeSHA = 'mutated';
  snap1.files['docs/specs/engine.md'] = { blobSHA: 'mutated', frontmatterStatus: 'mutated' };
  snap1.files['docs/specs/new-file.md'] = { blobSHA: 'injected', frontmatterStatus: 'injected' };

  // Get a second snapshot -- should be unaffected by mutations
  const snap2 = poller.getSnapshot();
  expect(snap2).toStrictEqual({
    specsDirTreeSHA: 'specs-tree-sha-1',
    files: {
      'docs/specs/engine.md': { blobSHA: 'blob-sha-1', frontmatterStatus: 'approved' },
    },
  });
});
