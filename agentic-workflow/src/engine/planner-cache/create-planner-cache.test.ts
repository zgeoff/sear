import { readFile } from 'node:fs/promises';
import { vol } from 'memfs';
import { expect, test, vi } from 'vitest';
import type { SpecPollerSnapshot } from '../pollers/types.ts';
import { createPlannerCache } from './create-planner-cache.ts';
import type { PlannerCacheConfig } from './types.ts';

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

test('it returns a valid snapshot when the cache file exists and is valid', async () => {
  const { config } = setupTest();
  const snapshot = buildValidSnapshot();
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(snapshot) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toStrictEqual(snapshot);
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
    specsDirTreeSHA: 'abc123',
    files: {
      'docs/specs/a.md': { blobSHA: 'def456' }, // missing frontmatterStatus
    },
  };
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(invalid) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toBeNull();
});

test('it accepts a snapshot with null tree SHA', async () => {
  const { config } = setupTest();
  const snapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: null,
    files: {},
  };
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(snapshot) });

  const cache = createPlannerCache(config);
  const result = await cache.load();

  expect(result).toStrictEqual(snapshot);
});

// ---------------------------------------------------------------------------
// write()
// ---------------------------------------------------------------------------

test('it writes the snapshot to the cache file atomically', async () => {
  const { config } = setupTest();
  vol.mkdirSync('/repo', { recursive: true });

  const snapshot = buildValidSnapshot();
  const cache = createPlannerCache(config);
  await cache.write(snapshot);

  const raw = await readFile('/repo/.agentic-workflow-cache.json', 'utf-8');
  expect(JSON.parse(raw)).toStrictEqual(snapshot);
});

test('it throws when writing a snapshot with null tree SHA', async () => {
  const { config } = setupTest();
  vol.mkdirSync('/repo', { recursive: true });

  const snapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: null,
    files: {},
  };
  const cache = createPlannerCache(config);

  await expect(cache.write(snapshot)).rejects.toThrow(
    'Planner cache write requires a non-null specsDirTreeSHA',
  );
});

test('it does not crash when the write fails due to a filesystem error', async () => {
  const { config } = setupTest();
  // Don't create /repo directory -- write will fail

  const snapshot = buildValidSnapshot();
  const cache = createPlannerCache(config);

  // Should not throw -- write errors are non-fatal
  await cache.write(snapshot);
});

test('it overwrites an existing cache file', async () => {
  const { config } = setupTest();
  const oldSnapshot = buildValidSnapshot();
  vol.fromJSON({ '/repo/.agentic-workflow-cache.json': JSON.stringify(oldSnapshot) });

  const newSnapshot: SpecPollerSnapshot = {
    specsDirTreeSHA: 'new-sha',
    files: {
      'docs/specs/new.md': {
        blobSHA: 'new-blob',
        frontmatterStatus: 'approved',
      },
    },
  };

  const cache = createPlannerCache(config);
  await cache.write(newSnapshot);

  const raw = await readFile('/repo/.agentic-workflow-cache.json', 'utf-8');
  expect(JSON.parse(raw)).toStrictEqual(newSnapshot);
});
