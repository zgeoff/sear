import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import matter from 'gray-matter';
import type { AgentQuery, QueryFactory, QueryFactoryConfig, QueryFactoryParams } from './types.ts';

export function buildQueryFactory(config: QueryFactoryConfig): QueryFactory {
  return async (params: QueryFactoryParams): Promise<AgentQuery> => {
    const loaded = await loadAgentDefinition(config.repoRoot, params.agent);
    const agentDefinition = loaded.definition;
    const contextBlock = await loadContextFiles(config.repoRoot, config.contextPaths);

    if (params.modelOverride !== undefined) {
      agentDefinition.model = params.modelOverride;
    }

    if (contextBlock.length > 0) {
      agentDefinition.prompt = `${agentDefinition.prompt}\n\n${contextBlock}`;
    }

    const sessionOptions: Record<string, unknown> = {
      agent: params.agent,
      agents: {
        [params.agent]: agentDefinition,
      },
      cwd: params.cwd,
      settingSources: [],
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [config.bashValidatorHook] }],
      },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController: params.abortController,
    };

    if (loaded.maxTurns !== undefined) {
      sessionOptions.maxTurns = loaded.maxTurns;
    }

    return query({
      prompt: params.prompt,
      options: sessionOptions,
    });
  };
}

type AgentModel = 'sonnet' | 'opus' | 'haiku' | 'inherit';

const VALID_MODELS: Record<string, AgentModel> = {
  sonnet: 'sonnet',
  opus: 'opus',
  haiku: 'haiku',
  inherit: 'inherit',
};

interface LoadedAgentDefinition {
  definition: AgentDefinition;
  maxTurns: number | undefined;
}

async function loadAgentDefinition(
  repoRoot: string,
  agentName: string,
): Promise<LoadedAgentDefinition> {
  const filePath = join(repoRoot, '.claude', 'agents', `${agentName}.md`);
  const fileContent = await readFile(filePath, 'utf-8');
  const parsed = matter(fileContent);

  const description = String(parsed.data.description ?? '');
  const prompt = parsed.content;
  const model = parseModel(parsed.data.model);
  const tools = parseTools(parsed.data.tools);
  const disallowedTools = parseTools(parsed.data.disallowedTools);
  const maxTurns = parseMaxTurns(parsed.data.maxTurns);

  const definition: AgentDefinition = {
    description,
    prompt,
    model,
  };

  if (tools !== undefined) {
    definition.tools = tools;
  }

  if (disallowedTools !== undefined) {
    definition.disallowedTools = disallowedTools;
  }

  return { definition, maxTurns };
}

async function loadContextFiles(repoRoot: string, contextPaths: string[]): Promise<string> {
  if (contextPaths.length === 0) {
    return '';
  }

  const contents = await Promise.all(
    contextPaths.map((contextPath) => readFile(join(repoRoot, contextPath), 'utf-8')),
  );

  return contents.join('\n\n');
}

function parseModel(raw: unknown): AgentModel {
  if (raw === null) {
    return 'inherit';
  }
  return VALID_MODELS[String(raw)] ?? 'inherit';
}

function parseTools(raw: unknown): string[] | undefined {
  if (raw === null) {
    return;
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return;
}

function parseMaxTurns(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) {
    return;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return;
}
