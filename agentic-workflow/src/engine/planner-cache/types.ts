import type { SpecPollerSnapshot } from '../pollers/types.ts';

export interface PlannerCacheConfig {
  repoRoot: string;
  logger: PlannerCacheLogger;
}

export interface PlannerCacheLogger {
  debug: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
}

export interface PlannerCache {
  load: () => Promise<SpecPollerSnapshot | null>;
  write: (snapshot: SpecPollerSnapshot) => Promise<void>;
}
