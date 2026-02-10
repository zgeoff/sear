import { readFile } from 'node:fs/promises';
import { vol } from 'memfs';
import { expect, test, vi } from 'vitest';
import type { SpecPollerSnapshot } from '../pollers/types.ts';
import { createPlannerCache } from './create-planner-cache.ts';
import type { PlannerCacheConfig, PlannerCacheEntry } from './types.ts';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

function buildValidSnapshot(): SpecPollerSnapshot {
  return {
    specsDirTreeSHA: 'abc123',
    files: {
      'docs/specs/workflow/control-plane.md': {
        blobSHA: 'def456',
        frontmatterStatus: 'approved',
      },
    },
  };
}

function buildValidCacheEntry(): PlannerCacheEntry {
  return {
    snapshot: buildValidSnapshot(),
    commitSHA: 'commit-sha-1',
  };
}

function setupTest(): { config: PlannerCacheConfig } {
  vol.reset();
  const config: PlannerCacheConfig = {
    repoRoot: '/repo',
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
    },
  };
  return { config };
}

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

test('it returns a valid cache entry when the cache file exists and is valid', async () => {
  const { config } = setupTest();
  const entry = buildValidCacheEntry();
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(entry) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toStrictEqual(entry);
});

test('it returns null when the cache file does not exist', async () => {
  const { config } = setupTest();

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it returns null when the cache file contains invalid JSON', async () => {
  const { config } = setupTest();
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': '{not valid json' });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it returns null when the cache file has an invalid schema', async () => {
  const { config } = setupTest();
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify({ wrong: 'shape' }) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it returns null when a file entry is missing required fields', async () => {
  const { config } = setupTest();
  const invalid = {
    snapshot: {
      specsDirTreeSHA: 'abc123',
      files: {
        'docs/specs/a.md': { blobSHA: 'def456' }, // missing frontmatterStatus
      },
    },
    commitSHA: 'sha123',
  };
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(invalid) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it returns null when the cache file uses the old flat format without a wrapper', async () => {
  const { config } = setupTest();
  const oldFormat: SpecPollerSnapshot = {
    specsDirTreeSHA: 'abc123',
    files: {
      'docs/specs/a.md': { blobSHA: 'def456', frontmatterStatus: 'approved' },
    },
  };
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(oldFormat) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it returns null when the snapshot field is missing', async () => {
  const { config } = setupTest();
  const invalid = { commitSHA: 'sha123' };
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(invalid) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it returns null when the commit SHA field is missing', async () => {
  const { config } = setupTest();
  const invalid = {
    snapshot: {
      specsDirTreeSHA: 'abc123',
      files: {},
    },
  };
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(invalid) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

// ---------------------------------------------------------------------------
// write()
// ---------------------------------------------------------------------------

test('it writes the snapshot and commit SHA to the cache file atomically', async () => {
  const { config } = setupTest();
  vol.mkdirSync('/repo', { recursive: true });

  const snapshot = buildValidSnapshot();
  const commitSHA = 'commit-sha-1';
  const cache = createPlannerCache(config);
  await cache.write(snapshot, commitSHA);

  const raw = await readFile('/repo/.agentic-workflow-cache.json', 'utf-8');
  const written: PlannerCacheEntry = JSON.parse(raw);
  expect(written).toStrictEqual({ snapshot, commitSHA });
});

test('it throws when writing a snapshot with null tree SHA', async () => {
  const { config } = setupTest();
  vol.mkdirSync('/repo', { recursive: true });

  const snapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: null,
    files: {},
  };
  const cache = createPlannerCache(config);

  await expect(cache.write(snapshot, 'sha123')).rejects.toThrow(
    'Planner cache write requires a non-null specsDirTreeSHA',
  );
});

test('it does not crash when the write fails due to a filesystem error', async () => {
  const { config } = setupTest();
  // Don't create /repo directory -- write will fail

  const snapshot = buildValidSnapshot();
  const cache = createPlannerCache(config);

  // Should not throw -- write errors are non-fatal
  await cache.write(snapshot, 'sha123');
});

test('it overwrites an existing cache file', async () => {
  const { config } = setupTest();
  const oldEntry = buildValidCacheEntry();
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(oldEntry) });

  const newSnapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: 'new-sha',
    files: {
      'docs/specs/new.md': {
        blobSHA: 'new-blob',
        frontmatterStatus: 'approved',
      },
    },
  };
  const newCommitSHA = 'new-commit-sha';

  const cache = createPlannerCache(config);
  await cache.write(newSnapshot, newCommitSHA);

  const raw = await readFile('/repo/.agentic-workflow-cache.json', 'utf-8');
  const written: PlannerCacheEntry = JSON.parse(raw);
  expect(written).toStrictEqual({ snapshot: newSnapshot, commitSHA: newCommitSHA });
});
