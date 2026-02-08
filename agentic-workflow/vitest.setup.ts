import { fs } from 'memfs';
import { vi } from 'vitest';

vi.mock('node:fs/promises', () => fs.promises);
