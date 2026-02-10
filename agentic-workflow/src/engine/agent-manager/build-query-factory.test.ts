import { query } from '@anthropic-ai/claude-agent-sdk';
import { vol } from 'memfs';
import invariant from 'tiny-invariant';
import { expect, test, vi } from 'vitest';
import { buildQueryFactory } from './build-query-factory.ts';
import type { QueryFactoryConfig, QueryFactoryParams } from './types.ts';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined }),
    }),
    interrupt: async () => {
      /* no-op */
    },
  })),
}));

const mockQuery: ReturnType<typeof vi.mocked<typeof query>> = vi.mocked(query);

interface SetupOverrides {
  agentName: string;
  frontmatter: string;
  body: string;
  contextPaths: string[];
}

function setupTest(overrides?: Partial<SetupOverrides>): {
  config: QueryFactoryConfig;
  params: QueryFactoryParams;
  bashValidatorHook: ReturnType<typeof vi.fn>;
} {
  vol.reset();
  mockQuery.mockClear();

  const agentName = overrides?.agentName ?? 'implementor';
  const repoRoot = '/test-repo';
  const frontmatter = overrides?.frontmatter ?? buildDefaultFrontmatter();
  const body = overrides?.body ?? 'You are the Implementor agent.';

  const fileContent = `---\n${frontmatter}---\n\n${body}`;
  vol.mkdirSync(`${repoRoot}/.claude/agents`, { recursive: true });
  vol.writeFileSync(`${repoRoot}/.claude/agents/${agentName}.md`, fileContent);

  const bashValidatorHook = vi.fn().mockResolvedValue({ decision: 'approve' });

  const config: QueryFactoryConfig = {
    repoRoot,
    bashValidatorHook,
    contextPaths: overrides?.contextPaths ?? [],
  };

  const params: QueryFactoryParams = {
    prompt: '42',
    agent: agentName,
    cwd: '/test-repo/.worktrees/issue-42',
    abortController: new AbortController(),
  };

  return { config, params, bashValidatorHook };
}

function buildDefaultFrontmatter(): string {
  return [
    'description: Executes assigned task issues',
    'tools: Read, Write, Edit, Grep, Glob, Bash',
    'model: opus',
    '',
  ].join('\n');
}

test('it reads the agent definition file and passes an inline definition to the SDK', async () => {
  const { config, params } = setupTest();

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: '42',
      options: expect.objectContaining({
        agent: 'implementor',
        agents: {
          implementor: expect.objectContaining({
            description: 'Executes assigned task issues',
            tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
            prompt: expect.stringContaining('You are the Implementor agent.'),
            model: 'opus',
          }),
        },
      }),
    }),
  );
});

test('it passes settings sources, permission mode, and dangerous skip flag to the SDK', async () => {
  const { config, params } = setupTest();

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }),
    }),
  );
});

test('it passes the bash validator hook as a pre-tool-use hook for Bash', async () => {
  const { config, params, bashValidatorHook } = setupTest();

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [bashValidatorHook] }],
        },
      }),
    }),
  );
});

test('it passes the working directory and abort controller to the SDK', async () => {
  const { config, params } = setupTest();

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        cwd: '/test-repo/.worktrees/issue-42',
        abortController: params.abortController,
      }),
    }),
  );
});

test('it splits comma-separated tools into an array', async () => {
  const { config, params } = setupTest({
    frontmatter: 'description: Test agent\ntools: Read, Grep, Glob\n',
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            tools: ['Read', 'Grep', 'Glob'],
          }),
        },
      }),
    }),
  );
});

test('it preserves array-format tools from YAML list syntax', async () => {
  const { config, params } = setupTest({
    frontmatter: 'description: Test agent\ntools:\n  - Read\n  - Bash\n',
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            tools: ['Read', 'Bash'],
          }),
        },
      }),
    }),
  );
});

test('it defaults model to inherit when not specified in frontmatter', async () => {
  const { config, params } = setupTest({
    frontmatter: 'description: Test agent\n',
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            model: 'inherit',
          }),
        },
      }),
    }),
  );
});

test('it uses the markdown body as the agent prompt', async () => {
  const { config, params } = setupTest({
    body: 'Custom prompt content.\n\nWith multiple paragraphs.',
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            prompt: expect.stringContaining('Custom prompt content.'),
          }),
        },
      }),
    }),
  );
});

test('it rejects with an error when the agent definition file does not exist', async () => {
  vol.reset();
  mockQuery.mockClear();

  const config: QueryFactoryConfig = {
    repoRoot: '/test-repo',
    bashValidatorHook: vi.fn().mockResolvedValue({ decision: 'approve' }),
    contextPaths: [],
  };

  const params: QueryFactoryParams = {
    prompt: '42',
    agent: 'implementor',
    cwd: '/test-repo/.worktrees/issue-42',
    abortController: new AbortController(),
  };

  await expect(buildQueryFactory(config)(params)).rejects.toThrow();
});

test('it reads different agent names from the correct file path', async () => {
  const { config, params } = setupTest({
    agentName: 'planner',
    frontmatter: 'description: Plans tasks from specs\nmodel: opus\n',
    body: 'You are the Planner agent.',
  });

  params.agent = 'planner';

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agent: 'planner',
        agents: {
          planner: expect.objectContaining({
            description: 'Plans tasks from specs',
            prompt: expect.stringContaining('You are the Planner agent.'),
            model: 'opus',
          }),
        },
      }),
    }),
  );
});

test('it omits tools from the definition when not specified in frontmatter', async () => {
  const { config, params } = setupTest({
    frontmatter: 'description: Test agent\nmodel: sonnet\n',
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledTimes(1);
  const callArgs = mockQuery.mock.calls[0];
  invariant(callArgs, 'query must have been called at least once');
  const agentDef = callArgs[0].options?.agents?.implementor;

  expect(agentDef).toBeDefined();
  expect(agentDef).not.toHaveProperty('tools');
});

test('it ignores unrelated frontmatter fields not part of the agent definition', async () => {
  const { config, params } = setupTest({
    frontmatter: [
      'name: implementor',
      'description: Executes tasks',
      'tools: Read, Bash',
      'model: opus',
      'permissionMode: bypassPermissions',
      'skills: github-workflow',
      '',
    ].join('\n'),
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledTimes(1);
  const callArgs = mockQuery.mock.calls[0];
  invariant(callArgs, 'query must have been called at least once');
  const agentDef = callArgs[0].options?.agents?.implementor;

  expect(agentDef).toMatchObject({
    description: 'Executes tasks',
    tools: ['Read', 'Bash'],
    model: 'opus',
  });

  expect(agentDef).not.toHaveProperty('name');
  expect(agentDef).not.toHaveProperty('permissionMode');
  expect(agentDef).not.toHaveProperty('skills');
});

test('it appends context files to the agent prompt with double newline separators', async () => {
  const { config, params } = setupTest({
    contextPaths: ['.claude/CLAUDE.md', 'docs/context.md'],
  });

  vol.mkdirSync('/test-repo/.claude', { recursive: true });
  vol.writeFileSync('/test-repo/.claude/CLAUDE.md', 'Project instructions here.');
  vol.mkdirSync('/test-repo/docs', { recursive: true });
  vol.writeFileSync('/test-repo/docs/context.md', 'Additional context.');

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledTimes(1);
  const callArgs = mockQuery.mock.calls[0];
  invariant(callArgs, 'query must have been called at least once');
  const agentDef = callArgs[0].options?.agents?.implementor;
  invariant(agentDef, 'agent definition must exist');

  const expectedPrompt = [
    '\nYou are the Implementor agent.',
    'Project instructions here.',
    'Additional context.',
  ].join('\n\n');

  expect(agentDef.prompt).toBe(expectedPrompt);
});

test('it leaves the prompt unchanged when context paths is empty', async () => {
  const { config, params } = setupTest({
    contextPaths: [],
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledTimes(1);
  const callArgs = mockQuery.mock.calls[0];
  invariant(callArgs, 'query must have been called at least once');
  const agentDef = callArgs[0].options?.agents?.implementor;
  invariant(agentDef, 'agent definition must exist');

  expect(agentDef.prompt).toBe('\nYou are the Implementor agent.');
});

test('it propagates the error when a context file does not exist', async () => {
  const { config, params } = setupTest({
    contextPaths: ['.claude/CLAUDE.md', 'missing/file.md'],
  });

  vol.mkdirSync('/test-repo/.claude', { recursive: true });
  vol.writeFileSync('/test-repo/.claude/CLAUDE.md', 'Project instructions here.');

  await expect(buildQueryFactory(config)(params)).rejects.toThrow();
});

test('it parses disallowed tools from frontmatter and includes them in the agent definition', async () => {
  const { config, params } = setupTest({
    frontmatter: [
      'description: Test agent',
      'tools: Read, Write, Bash',
      'disallowedTools: Bash, Edit',
      'model: opus',
      '',
    ].join('\n'),
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            tools: ['Read', 'Write', 'Bash'],
            disallowedTools: ['Bash', 'Edit'],
          }),
        },
      }),
    }),
  );
});

test('it passes the parsed max turns value as a session-level option', async () => {
  const { config, params } = setupTest({
    frontmatter: [
      'description: Test agent',
      'tools: Read, Bash',
      'model: opus',
      'maxTurns: 50',
      '',
    ].join('\n'),
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        maxTurns: 50,
      }),
    }),
  );
});

test('it omits the max turns session option when not specified in frontmatter', async () => {
  const { config, params } = setupTest({
    frontmatter: ['description: Test agent', 'tools: Read, Bash', 'model: opus', ''].join('\n'),
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledTimes(1);
  const callArgs = mockQuery.mock.calls[0];
  invariant(callArgs, 'query must have been called at least once');

  expect(callArgs[0].options).not.toHaveProperty('maxTurns');
});

test('it uses the model override instead of the frontmatter model when provided', async () => {
  const { config, params } = setupTest({
    frontmatter: ['description: Test agent', 'model: opus', ''].join('\n'),
  });

  params.modelOverride = 'sonnet';

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            model: 'sonnet',
          }),
        },
      }),
    }),
  );
});

test('it uses the frontmatter model when no model override is provided', async () => {
  const { config, params } = setupTest({
    frontmatter: ['description: Test agent', 'model: haiku', ''].join('\n'),
  });

  await buildQueryFactory(config)(params);

  expect(mockQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        agents: {
          implementor: expect.objectContaining({
            model: 'haiku',
          }),
        },
      }),
    }),
  );
});
