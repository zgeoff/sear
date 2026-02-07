import { expect, test, vi } from 'vitest';
import type { EngineConfig } from '../types.js';
import { buildResolvedConfig, loadConfig, validateConfig } from './config.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildValidConfig(overrides?: Partial<EngineConfig>): EngineConfig {
  return {
    repository: 'owner/repo',
    githubAppID: 12345,
    githubAppPrivateKeyPath: '/path/to/key.pem',
    githubAppInstallationID: 67890,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

test('validateConfig accepts a config with all required fields', () => {
  const config = buildValidConfig();
  expect(() => validateConfig(config as Record<string, unknown>)).not.toThrow();
});

test('validateConfig throws when repository is missing', () => {
  const config = { ...buildValidConfig() };
  delete (config as Record<string, unknown>).repository;
  expect(() => validateConfig(config as Record<string, unknown>)).toThrow(
    'Missing required config field: repository',
  );
});

test('validateConfig throws when githubAppID is missing', () => {
  const config = { ...buildValidConfig() };
  delete (config as Record<string, unknown>).githubAppID;
  expect(() => validateConfig(config as Record<string, unknown>)).toThrow(
    'Missing required config field: githubAppID',
  );
});

test('validateConfig throws when githubAppPrivateKeyPath is missing', () => {
  const config = { ...buildValidConfig() };
  delete (config as Record<string, unknown>).githubAppPrivateKeyPath;
  expect(() => validateConfig(config as Record<string, unknown>)).toThrow(
    'Missing required config field: githubAppPrivateKeyPath',
  );
});

test('validateConfig throws when githubAppInstallationID is missing', () => {
  const config = { ...buildValidConfig() };
  delete (config as Record<string, unknown>).githubAppInstallationID;
  expect(() => validateConfig(config as Record<string, unknown>)).toThrow(
    'Missing required config field: githubAppInstallationID',
  );
});

test('validateConfig throws on invalid logLevel', () => {
  const config = { ...buildValidConfig(), logLevel: 'verbose' };
  expect(() => validateConfig(config as Record<string, unknown>)).toThrow(
    "Invalid logLevel: 'verbose'. Must be one of: debug, info, error",
  );
});

test('validateConfig accepts valid logLevel values', () => {
  for (const level of ['debug', 'info', 'error'] as const) {
    const config = buildValidConfig({ logLevel: level });
    expect(() => validateConfig(config as Record<string, unknown>)).not.toThrow();
  }
});

// ---------------------------------------------------------------------------
// buildResolvedConfig — defaults
// ---------------------------------------------------------------------------

test('buildResolvedConfig applies all defaults when optional fields are omitted', () => {
  const config = buildValidConfig();
  const resolved = buildResolvedConfig(config);

  expect(resolved.logLevel).toBe('info');
  expect(resolved.shutdownTimeout).toBe(300);
  expect(resolved.issuePoller.pollInterval).toBe(30);
  expect(resolved.specPoller.pollInterval).toBe(60);
  expect(resolved.specPoller.specsDir).toBe('docs/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('main');
  expect(resolved.agents.agentFilePlanner).toBe('.claude/agents/planner.md');
  expect(resolved.agents.agentFileImplementor).toBe('.claude/agents/implementor.md');
  expect(resolved.agents.agentFileReviewer).toBe('.claude/agents/reviewer.md');
  expect(resolved.agents.maxAgentDuration).toBe(1800);
});

test('buildResolvedConfig preserves required fields', () => {
  const config = buildValidConfig();
  const resolved = buildResolvedConfig(config);

  expect(resolved.repository).toBe('owner/repo');
  expect(resolved.githubAppID).toBe(12345);
  expect(resolved.githubAppPrivateKeyPath).toBe('/path/to/key.pem');
  expect(resolved.githubAppInstallationID).toBe(67890);
});

test('buildResolvedConfig uses provided optional values over defaults', () => {
  const config = buildValidConfig({
    logLevel: 'debug',
    shutdownTimeout: 600,
    issuePoller: { pollInterval: 15 },
    specPoller: {
      pollInterval: 120,
      specsDir: 'custom/specs/',
      defaultBranch: 'develop',
    },
    agents: {
      agentFilePlanner: 'custom/planner.md',
      agentFileImplementor: 'custom/implementor.md',
      agentFileReviewer: 'custom/reviewer.md',
      maxAgentDuration: 3600,
    },
  });
  const resolved = buildResolvedConfig(config);

  expect(resolved.logLevel).toBe('debug');
  expect(resolved.shutdownTimeout).toBe(600);
  expect(resolved.issuePoller.pollInterval).toBe(15);
  expect(resolved.specPoller.pollInterval).toBe(120);
  expect(resolved.specPoller.specsDir).toBe('custom/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('develop');
  expect(resolved.agents.agentFilePlanner).toBe('custom/planner.md');
  expect(resolved.agents.agentFileImplementor).toBe('custom/implementor.md');
  expect(resolved.agents.agentFileReviewer).toBe('custom/reviewer.md');
  expect(resolved.agents.maxAgentDuration).toBe(3600);
});

test('buildResolvedConfig handles partial nested objects', () => {
  const config = buildValidConfig({
    specPoller: { pollInterval: 120 },
  });
  const resolved = buildResolvedConfig(config);

  expect(resolved.specPoller.pollInterval).toBe(120);
  expect(resolved.specPoller.specsDir).toBe('docs/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('main');
});

// ---------------------------------------------------------------------------
// loadConfig — file not found
// ---------------------------------------------------------------------------

test('loadConfig exits process when config file does not exist', async () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(
    loadConfig({ configPath: '/nonexistent/agentic-workflow.config.ts' }),
  ).rejects.toThrow('process.exit called');

  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to load config file:'));

  exitSpy.mockRestore();
  errorSpy.mockRestore();
});
