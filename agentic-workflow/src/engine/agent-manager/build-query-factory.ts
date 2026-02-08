import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFactory } from './types';

export function buildQueryFactory(): QueryFactory {
  return (params) => {
    return query({
      prompt: params.prompt,
      options: {
        agent: params.agent,
        cwd: params.cwd,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController: params.abortController,
      },
    });
  };
}
