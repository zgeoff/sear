import type { SpecPollerSnapshot } from '../pollers/types.ts';

export interface PlannerCacheEntry {
  snapshot: SpecPollerSnapshot;
  commitSHA: string;
}

export interface PlannerCacheConfig {
  repoRoot: string;
  logger: PlannerCacheLogger;
}

export interface PlannerCacheLogger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export interface PlannerCache {
  load: () => Promise<PlannerCacheEntry | null>;
  write: (snapshot: SpecPollerSnapshot, commitSHA: string) => Promise<void>;
}
