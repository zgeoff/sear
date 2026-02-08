import { expect, test } from 'vitest';
import { buildValidConfig } from '../../test-utils/build-valid-config';
import { buildResolvedConfig } from './build-resolved-config';

test('it applies all default values when optional fields are omitted', () => {
  const config = buildValidConfig();
  const resolved = buildResolvedConfig(config);

  expect(resolved.logLevel).toBe('info');
  expect(resolved.shutdownTimeout).toBe(300);
  expect(resolved.issuePoller.pollInterval).toBe(30);
  expect(resolved.specPoller.pollInterval).toBe(60);
  expect(resolved.specPoller.specsDir).toBe('docs/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('main');
  expect(resolved.agents.agentPlanner).toBe('planner');
  expect(resolved.agents.agentImplementor).toBe('implementor');
  expect(resolved.agents.agentReviewer).toBe('reviewer');
  expect(resolved.agents.maxAgentDuration).toBe(1800);
  expect(resolved.logging.agentSessions).toBe(false);
  expect(resolved.logging.logsDir).toBe('logs');
});

test('it preserves required fields in the resolved config', () => {
  const config = buildValidConfig();
  const resolved = buildResolvedConfig(config);

  expect(resolved.repository).toBe('owner/repo');
  expect(resolved.githubAppID).toBe(12345);
  expect(resolved.githubAppPrivateKeyPath).toBe('/path/to/key.pem');
  expect(resolved.githubAppInstallationID).toBe(67890);
});

test('it uses provided optional values instead of defaults', () => {
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
      agentPlanner: 'custom-planner',
      agentImplementor: 'custom-implementor',
      agentReviewer: 'custom-reviewer',
      maxAgentDuration: 3600,
    },
    logging: {
      agentSessions: true,
      logsDir: '/custom/path',
    },
  });
  const resolved = buildResolvedConfig(config);

  expect(resolved.logLevel).toBe('debug');
  expect(resolved.shutdownTimeout).toBe(600);
  expect(resolved.issuePoller.pollInterval).toBe(15);
  expect(resolved.specPoller.pollInterval).toBe(120);
  expect(resolved.specPoller.specsDir).toBe('custom/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('develop');
  expect(resolved.agents.agentPlanner).toBe('custom-planner');
  expect(resolved.agents.agentImplementor).toBe('custom-implementor');
  expect(resolved.agents.agentReviewer).toBe('custom-reviewer');
  expect(resolved.agents.maxAgentDuration).toBe(3600);
  expect(resolved.logging.agentSessions).toBe(true);
  expect(resolved.logging.logsDir).toBe('/custom/path');
});

test('it fills in missing defaults for partially provided nested objects', () => {
  const config = buildValidConfig({
    specPoller: { pollInterval: 120 },
  });
  const resolved = buildResolvedConfig(config);

  expect(resolved.specPoller.pollInterval).toBe(120);
  expect(resolved.specPoller.specsDir).toBe('docs/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('main');
});

test('it fills in missing logging defaults when only some logging fields are provided', () => {
  const config = buildValidConfig({
    logging: { agentSessions: true },
  });
  const resolved = buildResolvedConfig(config);

  expect(resolved.logging.agentSessions).toBe(true);
  expect(resolved.logging.logsDir).toBe('logs');
});
