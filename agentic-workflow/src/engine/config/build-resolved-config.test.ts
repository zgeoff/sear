import { expect, test } from 'vitest';
import { buildValidConfig } from '../../test-utils/build-valid-config.js';
import { buildResolvedConfig } from './build-resolved-config.js';

test('it applies all default values when optional fields are omitted', () => {
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

test('it fills in missing defaults for partially provided nested objects', () => {
  const config = buildValidConfig({
    specPoller: { pollInterval: 120 },
  });
  const resolved = buildResolvedConfig(config);

  expect(resolved.specPoller.pollInterval).toBe(120);
  expect(resolved.specPoller.specsDir).toBe('docs/specs/');
  expect(resolved.specPoller.defaultBranch).toBe('main');
});
