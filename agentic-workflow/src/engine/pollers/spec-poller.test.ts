import { expect, test, vi } from 'vitest';
import { createSpecPoller, parseFrontmatterStatus } from './spec-poller.js';

// ---------------------------------------------------------------------------
// Mock Octokit factory
// ---------------------------------------------------------------------------

type TreeEntry = {
  path: string;
  sha: string;
  type: 'blob' | 'tree';
};

type MockOctokitHandlers = {
  getTree: (params: { tree_sha: string; recursive?: string }) => {
    data: { sha: string; tree: TreeEntry[] };
  };
  getContent: (params: { path: string; ref: string }) => {
    data: { content: string; encoding: string };
  };
  getRef: (params: { ref: string }) => {
    data: { object: { sha: string } };
  };
};

function buildMockOctokit(handlers: Partial<MockOctokitHandlers> = {}) {
  return {
    git: {
      getTree: vi.fn(async (params: { tree_sha: string; recursive?: string }) => {
        if (handlers.getTree) return handlers.getTree(params);
        return { data: { sha: '', tree: [] } };
      }),
      getRef: vi.fn(async (params: { ref: string }) => {
        if (handlers.getRef) return handlers.getRef(params);
        return { data: { object: { sha: 'head-commit-sha' } } };
      }),
    },
    repos: {
      getContent: vi.fn(async (params: { path: string; ref: string }) => {
        if (handlers.getContent) return handlers.getContent(params);
        return { data: { content: '', encoding: 'base64' } };
      }),
    },
  };
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

type SetupOptions = {
  handlers?: Partial<MockOctokitHandlers>;
  specsDir?: string;
  defaultBranch?: string;
};

function setupTest(options: SetupOptions = {}) {
  const octokit = buildMockOctokit(options.handlers);
  const poller = createSpecPoller({
    octokit: octokit as never,
    owner: 'test-owner',
    repo: 'test-repo',
    specsDir: options.specsDir ?? 'docs/specs/',
    defaultBranch: options.defaultBranch ?? 'main',
  });
  return { octokit, poller };
}

// ---------------------------------------------------------------------------
// Tree handler builder
// ---------------------------------------------------------------------------

function buildTreeHandlers(specsDirTreeSHA: string, specFiles: TreeEntry[]) {
  return {
    getTree: (params: { tree_sha: string; recursive?: string }) => {
      // Root recursive tree (branch name) -- includes specs dir entry
      if (params.tree_sha === 'main') {
        return {
          data: {
            sha: 'root-tree-sha',
            tree: [
              { path: 'docs', sha: 'docs-tree-sha', type: 'tree' as const },
              { path: 'docs/specs', sha: specsDirTreeSHA, type: 'tree' as const },
            ],
          },
        };
      }
      // Specs subtree (recursive fetch for change detection)
      if (params.tree_sha === specsDirTreeSHA) {
        return {
          data: {
            sha: specsDirTreeSHA,
            tree: specFiles,
          },
        };
      }
      return { data: { sha: '', tree: [] } };
    },
  };
}

// ---------------------------------------------------------------------------
// parseFrontmatterStatus
// ---------------------------------------------------------------------------

test('parseFrontmatterStatus extracts status from valid frontmatter', () => {
  const content = buildSpecContent('approved');
  expect(parseFrontmatterStatus(content)).toBe('approved');
});

test('parseFrontmatterStatus extracts draft status', () => {
  const content = buildSpecContent('draft');
  expect(parseFrontmatterStatus(content)).toBe('draft');
});

test('parseFrontmatterStatus returns null when no frontmatter exists', () => {
  expect(parseFrontmatterStatus('# Just a heading\n\nNo frontmatter.')).toBeNull();
});

test('parseFrontmatterStatus returns null when frontmatter has no status', () => {
  const content = '---\ntitle: Test\nversion: 0.1.0\n---\n\n# Content';
  expect(parseFrontmatterStatus(content)).toBeNull();
});

test('parseFrontmatterStatus trims whitespace from status value', () => {
  const content = '---\nstatus:   approved  \n---\n\nContent';
  expect(parseFrontmatterStatus(content)).toBe('approved');
});

// ---------------------------------------------------------------------------
// SpecPoller — single API call for tree SHA
// ---------------------------------------------------------------------------

test('poll uses a single API call to fetch the specs directory tree SHA', async () => {
  const specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: {
        content: toBase64(buildSpecContent('approved')),
        encoding: 'base64',
      },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });
  await poller.poll();

  // First getTree call: recursive tree on branch (to find specs dir SHA)
  // Second getTree call: recursive tree on specs dir (to inspect files)
  // The first call is the "single API call" to get the tree SHA
  const firstCall = octokit.git.getTree.mock.calls[0];
  expect(firstCall?.[0]).toEqual(expect.objectContaining({ tree_sha: 'main', recursive: 'true' }));
});

// ---------------------------------------------------------------------------
// SpecPoller — tree SHA unchanged (no further API calls)
// ---------------------------------------------------------------------------

test('poll returns empty result and makes no content calls when tree SHA is unchanged', async () => {
  const specFiles = [{ path: 'workflow/engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: {
        content: toBase64(buildSpecContent('approved')),
        encoding: 'base64',
      },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-abc' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });

  // First poll -- populates snapshot
  await poller.poll();

  octokit.git.getTree.mockClear();
  octokit.repos.getContent.mockClear();
  octokit.git.getRef.mockClear();

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

test('poll detects new spec files and returns changes with frontmatter status', async () => {
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
      data: {
        content: toBase64(contentMap[params.path] ?? ''),
        encoding: 'base64',
      },
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

test('poll detects modified files when blob SHA changes', async () => {
  let specsDirTreeSHA = 'specs-tree-sha-1';
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
              { path: 'docs/specs', sha: specsDirTreeSHA, type: 'tree' as const },
            ],
          },
        };
      }
      return { data: { sha: specsDirTreeSHA, tree: specFiles } };
    },
    getContent: () => ({
      data: { content: toBase64(engineContent), encoding: 'base64' },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const { poller } = setupTest({ handlers });

  // First poll: detects new file with draft status
  const result1 = await poller.poll();
  expect(result1.changes).toHaveLength(1);
  expect(result1.changes[0]?.frontmatterStatus).toBe('draft');

  // Simulate file modification: new blob SHA, new tree SHA, new content
  specsDirTreeSHA = 'specs-tree-sha-2';
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

test('poll removes deleted files from snapshot without including them in result', async () => {
  let specsDirTreeSHA = 'specs-tree-sha-1';
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
              { path: 'docs/specs', sha: specsDirTreeSHA, type: 'tree' as const },
            ],
          },
        };
      }
      return { data: { sha: specsDirTreeSHA, tree: specFiles } };
    },
    getContent: (params: { path: string }) => ({
      data: {
        content: toBase64(contentMap[params.path] ?? ''),
        encoding: 'base64',
      },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const { poller } = setupTest({ handlers });

  // First poll: detect both files
  const result1 = await poller.poll();
  expect(result1.changes).toHaveLength(2);

  // Remove tui.md from tree
  specsDirTreeSHA = 'specs-tree-sha-2';
  specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  // Second poll: tree changed but engine.md blob SHA is same, tui.md removed
  const result2 = await poller.poll();
  expect(result2.changes).toHaveLength(0);

  // Verify: adding tui.md back as new should detect it again
  specsDirTreeSHA = 'specs-tree-sha-3';
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

test('poll returns empty result on GitHub API error without crashing', async () => {
  const octokit = buildMockOctokit();
  octokit.git.getTree.mockRejectedValue(new Error('GitHub API rate limit exceeded'));

  const poller = createSpecPoller({
    octokit: octokit as never,
    owner: 'test-owner',
    repo: 'test-repo',
    specsDir: 'docs/specs/',
    defaultBranch: 'main',
  });

  const result = await poller.poll();
  expect(result.changes).toHaveLength(0);
  expect(result.commitSHA).toBe('');
});

// ---------------------------------------------------------------------------
// SpecPoller — specs directory not found
// ---------------------------------------------------------------------------

test('poll returns empty result when specs directory does not exist in tree', async () => {
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

test('poll fetches HEAD commit SHA only when changes are detected', async () => {
  const specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  // File has no parseable frontmatter -- will be skipped
  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: {
        content: toBase64('# No frontmatter\n\nJust content.'),
        encoding: 'base64',
      },
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

test('poll skips files whose content fetch fails and continues with others', async () => {
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
        data: {
          content: toBase64(buildSpecContent('approved')),
          encoding: 'base64',
        },
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

test('poll does not fetch content for files with unchanged blob SHA', async () => {
  let specsDirTreeSHA = 'specs-tree-sha-1';
  let specFiles = [{ path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const }];

  const handlers = {
    getTree: (params: { tree_sha: string; recursive?: string }) => {
      if (params.tree_sha === 'main') {
        return {
          data: {
            sha: 'root-sha',
            tree: [
              { path: 'docs', sha: 'docs-sha', type: 'tree' as const },
              { path: 'docs/specs', sha: specsDirTreeSHA, type: 'tree' as const },
            ],
          },
        };
      }
      return { data: { sha: specsDirTreeSHA, tree: specFiles } };
    },
    getContent: () => ({
      data: {
        content: toBase64(buildSpecContent('approved')),
        encoding: 'base64',
      },
    }),
    getRef: () => ({ data: { object: { sha: 'head-sha' } } }),
  };

  const { octokit, poller } = setupTest({ handlers });

  // First poll: detects new file
  await poller.poll();

  // Change tree SHA but keep same blob SHA for engine.md, add a new file
  specsDirTreeSHA = 'specs-tree-sha-2';
  specFiles = [
    { path: 'engine.md', sha: 'blob-sha-1', type: 'blob' as const },
    { path: 'tui.md', sha: 'blob-sha-new', type: 'blob' as const },
  ];

  octokit.repos.getContent.mockClear();

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

test('poll treats first cycle as all files being new', async () => {
  const specFiles = [
    { path: 'a.md', sha: 'sha-a', type: 'blob' as const },
    { path: 'b.md', sha: 'sha-b', type: 'blob' as const },
    { path: 'c.md', sha: 'sha-c', type: 'blob' as const },
  ];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: {
        content: toBase64(buildSpecContent('approved')),
        encoding: 'base64',
      },
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

test('poll ignores tree entries that are not blobs', async () => {
  const specFiles: TreeEntry[] = [
    { path: 'workflow', sha: 'subdir-sha', type: 'tree' },
    { path: 'workflow/engine.md', sha: 'blob-sha-1', type: 'blob' },
  ];

  const handlers = {
    ...buildTreeHandlers('specs-tree-sha-1', specFiles),
    getContent: () => ({
      data: {
        content: toBase64(buildSpecContent('approved')),
        encoding: 'base64',
      },
    }),
    getRef: () => ({ data: { object: { sha: 'commit-sha' } } }),
  };

  const { poller } = setupTest({ handlers });
  const result = await poller.poll();

  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]?.filePath).toBe('docs/specs/workflow/engine.md');
});
