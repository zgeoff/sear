import type { EngineConfig } from '../../types.ts';

const VALID_LOG_LEVELS: Set<string> = new Set(['debug', 'info', 'error']);

interface RequiredField {
  key: string;
  label: string;
}

const REQUIRED_FIELDS: RequiredField[] = [
  { key: 'repository', label: 'repository' },
  { key: 'githubAppID', label: 'githubAppID' },
  { key: 'githubAppPrivateKeyPath', label: 'githubAppPrivateKeyPath' },
  { key: 'githubAppInstallationID', label: 'githubAppInstallationID' },
];

export function validateConfig(config: unknown): asserts config is EngineConfig {
  if (!isRecord(config)) {
    throw new Error('Config must be a non-null object');
  }

  for (const { key, label } of REQUIRED_FIELDS) {
    if (config[key] === undefined || config[key] === null) {
      throw new Error(`Missing required config field: ${label}`);
    }
  }

  if (
    config.logLevel !== undefined &&
    (typeof config.logLevel !== 'string' || !VALID_LOG_LEVELS.has(config.logLevel))
  ) {
    throw new Error(
      `Invalid logLevel: '${String(config.logLevel)}'. Must be one of: debug, info, error`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
