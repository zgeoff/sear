import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import type { SpecPollerFileEntry, SpecPollerSnapshot } from '../pollers/types.ts';
import type { PlannerCache, PlannerCacheConfig } from './types.ts';

const CACHE_FILENAME = '.agentic-workflow-cache.json';

export function createPlannerCache(config: PlannerCacheConfig): PlannerCache {
  const cachePath = join(config.repoRoot, CACHE_FILENAME);
  const tempPath = `${cachePath}.tmp`;

  return {
    async load(): Promise<SpecPollerSnapshot | null> {
      try {
        const raw = await readFile(cachePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        return validateSnapshot(parsed);
      } catch (error) {
        config.logger.debug('Planner cache not loaded, starting cold', {
          path: cachePath,
          error: String(error),
        });
        return null;
      }
    },

    async write(snapshot: SpecPollerSnapshot): Promise<void> {
      invariant(
        snapshot.specsDirTreeSHA !== null,
        'Planner cache write requires a non-null specsDirTreeSHA',
      );

      try {
        const json = JSON.stringify(snapshot);
        await writeFile(tempPath, json, 'utf-8');
        await rename(tempPath, cachePath);
      } catch (error) {
        config.logger.error('Failed to write planner cache', {
          path: cachePath,
          error: String(error),
        });
      }
    },
  };
}

function validateSnapshot(value: unknown): SpecPollerSnapshot | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.specsDirTreeSHA !== 'string' && obj.specsDirTreeSHA !== null) {
    return null;
  }

  if (typeof obj.files !== 'object' || obj.files === null) {
    return null;
  }

  const files = obj.files as Record<string, unknown>;
  const validatedFiles: Record<string, SpecPollerFileEntry> = {};

  for (const [path, entry] of Object.entries(files)) {
    if (!validateFileEntry(entry)) {
      return null;
    }
    validatedFiles[path] = entry;
  }

  return {
    specsDirTreeSHA: obj.specsDirTreeSHA as string | null,
    files: validatedFiles,
  };
}

function validateFileEntry(value: unknown): value is SpecPollerFileEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return typeof obj.blobSHA === 'string' && typeof obj.frontmatterStatus === 'string';
}
