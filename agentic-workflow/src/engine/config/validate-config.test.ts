import { expect, test } from 'vitest';
import { buildValidConfig } from '../../test-utils/build-valid-config.ts';
import { validateConfig } from './validate-config.ts';

test('it accepts a valid config with all required fields', () => {
  const config = buildValidConfig();
  expect(() => validateConfig(config)).not.toThrow();
});

test('it throws when the repository field is missing', () => {
  const { repository: _, ...config } = buildValidConfig();
  expect(() => validateConfig(config)).toThrow('Missing required config field: repository');
});

test('it throws when the GitHub app ID is missing', () => {
  const { githubAppID: _, ...config } = buildValidConfig();
  expect(() => validateConfig(config)).toThrow('Missing required config field: githubAppID');
});

test('it throws when the GitHub app private key path is missing', () => {
  const { githubAppPrivateKeyPath: _, ...config } = buildValidConfig();
  expect(() => validateConfig(config)).toThrow(
    'Missing required config field: githubAppPrivateKeyPath',
  );
});

test('it throws when the GitHub app installation ID is missing', () => {
  const { githubAppInstallationID: _, ...config } = buildValidConfig();
  expect(() => validateConfig(config)).toThrow(
    'Missing required config field: githubAppInstallationID',
  );
});

test('it throws when the log level is not a recognized value', () => {
  const config = { ...buildValidConfig(), logLevel: 'verbose' };
  expect(() => validateConfig(config)).toThrow(
    "Invalid logLevel: 'verbose'. Must be one of: debug, info, error",
  );
});

test('it accepts all valid log level values', () => {
  for (const level of ['debug', 'info', 'error'] as const) {
    const config = buildValidConfig({ logLevel: level });
    expect(() => validateConfig(config)).not.toThrow();
  }
});
