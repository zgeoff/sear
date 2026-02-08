import type { EngineConfig } from '../types';

export function buildValidConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    repository: 'owner/repo',
    githubAppID: 12345,
    githubAppPrivateKeyPath: '/path/to/key.pem',
    githubAppInstallationID: 67890,
    ...overrides,
  };
}
