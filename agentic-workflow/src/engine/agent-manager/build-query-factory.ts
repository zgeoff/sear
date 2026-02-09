import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import matter from 'gray-matter';
import type { QueryFactory, QueryFactoryConfig } from './types';

export function buildQueryFactory(config: QueryFactoryConfig): QueryFactory {
  return async (params) => {
    const agentDefinition = await loadAgentDefinition(config.repoRoot, params.agent);
    return query({
      prompt: params.prompt,
      options: {
        agent: params.agent,
        agents: {
          [params.agent]: agentDefinition,
        },
        cwd: params.cwd,
        settingSources: ['project'],
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [config.bashValidatorHook] }],
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController: params.abortController,
      },
    });
  };
}

const VALID_MODELS = new Set(['sonnet', 'opus', 'haiku', 'inherit']);

type AgentModel = 'sonnet' | 'opus' | 'haiku' | 'inherit';

async function loadAgentDefinition(repoRoot: string, agentName: string): Promise<AgentDefinition> {
  const filePath = join(repoRoot, '.claude', 'agents', `${agentName}.md`);
  const fileContent = await readFile(filePath, 'utf-8');
  const parsed = matter(fileContent);

  const description = String(parsed.data.description ?? '');
  const prompt = parsed.content;
  const model = parseModel(parsed.data.model);
  const tools = parseTools(parsed.data.tools);

  const definition: AgentDefinition = {
    description,
    prompt,
    model,
  };

  if (tools !== undefined) {
    definition.tools = tools;
  }

  return definition;
}

function parseModel(raw: unknown): AgentModel {
  if (raw == null) return 'inherit';
  const value = String(raw);
  if (VALID_MODELS.has(value)) return value as AgentModel;
  return 'inherit';
}

function parseTools(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}
