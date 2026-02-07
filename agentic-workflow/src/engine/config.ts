import { resolve } from 'node:path';
import type { EngineConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Resolved Configuration (all defaults applied)
// ---------------------------------------------------------------------------

export type ResolvedEngineConfig = {
  repository: string;
  githubAppID: number;
  githubAppPrivateKeyPath: string;
  githubAppInstallationID: number;
  logLevel: 'debug' | 'info' | 'error';
  shutdownTimeout: number;
  issuePoller: {
    pollInterval: number;
  };
  specPoller: {
    pollInterval: number;
    specsDir: string;
    defaultBranch: string;
  };
  agents: {
    agentFilePlanner: string;
    agentFileImplementor: string;
    agentFileReviewer: string;
    maxAgentDuration: number;
  };
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  logLevel: 'info' as const,
  shutdownTimeout: 300,
  issuePoller: {
    pollInterval: 30,
  },
  specPoller: {
    pollInterval: 60,
    specsDir: 'docs/specs/',
    defaultBranch: 'main',
  },
  agents: {
    agentFilePlanner: '.claude/agents/planner.md',
    agentFileImplementor: '.claude/agents/implementor.md',
    agentFileReviewer: '.claude/agents/reviewer.md',
    maxAgentDuration: 1800,
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'error']);

type RequiredField = {
  key: string;
  label: string;
};

const REQUIRED_FIELDS: RequiredField[] = [
  { key: 'repository', label: 'repository' },
  { key: 'githubAppID', label: 'githubAppID' },
  { key: 'githubAppPrivateKeyPath', label: 'githubAppPrivateKeyPath' },
  { key: 'githubAppInstallationID', label: 'githubAppInstallationID' },
];

export function validateConfig(config: Record<string, unknown>): asserts config is EngineConfig {
  for (const { key, label } of REQUIRED_FIELDS) {
    if (config[key] === undefined || config[key] === null) {
      throw new Error(`Missing required config field: ${label}`);
    }
  }

  if (config.logLevel !== undefined && !VALID_LOG_LEVELS.has(config.logLevel as string)) {
    throw new Error(
      `Invalid logLevel: '${String(config.logLevel)}'. Must be one of: debug, info, error`,
    );
  }
}

// ---------------------------------------------------------------------------
// Build Resolved Config (apply defaults)
// ---------------------------------------------------------------------------

export function buildResolvedConfig(config: EngineConfig): ResolvedEngineConfig {
  return {
    repository: config.repository,
    githubAppID: config.githubAppID,
    githubAppPrivateKeyPath: config.githubAppPrivateKeyPath,
    githubAppInstallationID: config.githubAppInstallationID,
    logLevel: config.logLevel ?? DEFAULTS.logLevel,
    shutdownTimeout: config.shutdownTimeout ?? DEFAULTS.shutdownTimeout,
    issuePoller: {
      pollInterval: config.issuePoller?.pollInterval ?? DEFAULTS.issuePoller.pollInterval,
    },
    specPoller: {
      pollInterval: config.specPoller?.pollInterval ?? DEFAULTS.specPoller.pollInterval,
      specsDir: config.specPoller?.specsDir ?? DEFAULTS.specPoller.specsDir,
      defaultBranch: config.specPoller?.defaultBranch ?? DEFAULTS.specPoller.defaultBranch,
    },
    agents: {
      agentFilePlanner: config.agents?.agentFilePlanner ?? DEFAULTS.agents.agentFilePlanner,
      agentFileImplementor:
        config.agents?.agentFileImplementor ?? DEFAULTS.agents.agentFileImplementor,
      agentFileReviewer: config.agents?.agentFileReviewer ?? DEFAULTS.agents.agentFileReviewer,
      maxAgentDuration: config.agents?.maxAgentDuration ?? DEFAULTS.agents.maxAgentDuration,
    },
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

type LoadConfigOptions = {
  configPath?: string;
};

export async function loadConfig(options?: LoadConfigOptions): Promise<ResolvedEngineConfig> {
  const configPath = resolve(options?.configPath ?? 'agentic-workflow.config.ts');
  const rawModule = await importConfigFile(configPath);

  const config = rawModule.default as Record<string, unknown> | undefined;
  if (!config || typeof config !== 'object') {
    throw new Error(`Config file must have a default export: ${configPath}`);
  }

  validateConfig(config);

  return buildResolvedConfig(config);
}

async function importConfigFile(configPath: string): Promise<Record<string, unknown>> {
  try {
    return (await import(configPath)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to load config file: ${configPath}\n${message}`);
    return process.exit(1);
  }
}
