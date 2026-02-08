import { resolve } from 'node:path';
import { buildResolvedConfig } from './build-resolved-config';
import type { ResolvedEngineConfig } from './types';
import { validateConfig } from './validate-config';

export type LogError = (message: string) => void;

export type LoadConfigOptions = {
  configPath?: string;
  logError?: LogError;
};

export async function loadConfig(options?: LoadConfigOptions): Promise<ResolvedEngineConfig> {
  const configPath = resolve(options?.configPath ?? 'agentic-workflow.config.ts');
  const logError = options?.logError ?? console.error;
  const rawModule = await importConfigFile(configPath, logError);

  if (!isRecord(rawModule) || !('default' in rawModule)) {
    throw new Error(`Config file must have a default export: ${configPath}`);
  }

  const config: unknown = rawModule.default;
  if (!isRecord(config)) {
    throw new Error(`Config file must have a default export: ${configPath}`);
  }

  validateConfig(config);

  return buildResolvedConfig(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function importConfigFile(configPath: string, logError: LogError): Promise<unknown> {
  try {
    return await import(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`Failed to load config file: ${configPath}\n${message}`);
    return process.exit(1);
  }
}
