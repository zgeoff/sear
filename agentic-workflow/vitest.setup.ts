import { fs } from 'memfs';
import { afterEach, vi } from 'vitest';

vi.mock('node:fs/promises', () => fs.promises);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
