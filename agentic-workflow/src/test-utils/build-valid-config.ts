import type { EngineConfig } from '../types.ts';

export function buildValidConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    repository: 'owner/repo',
    githubAppID: 12_345,
    githubAppPrivateKeyPath: '/path/to/key.pem',
    githubAppInstallationID: 67_890,
    ...overrides,
  };
}
