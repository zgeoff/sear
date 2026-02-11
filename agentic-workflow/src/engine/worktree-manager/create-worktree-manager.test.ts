import { resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  buildBranchName,
  buildWorktreePath,
  createWorktreeManager,
} from './create-worktree-manager.ts';
import type { ExecGit } from './types.ts';

interface GitCall {
  args: string[];
}

function setupTest(): {
  manager: ReturnType<typeof createWorktreeManager>;
  execGit: ExecGit;
  calls: GitCall[];
  setResponse: (args: string[], stdout: string) => void;
  setFailure: (args: string[]) => void;
  repoRoot: string;
} {
  const repoRoot = '/repo';
  const calls: GitCall[] = [];
  const responses = new Map<string, { stdout: string; stderr: string }>();
  const failures = new Set<string>();

  const execGit: ExecGit = vi.fn(async (args: string[]) => {
    const key = args.join(' ');
    calls.push({ args });

    if (failures.has(key)) {
      throw new Error(`git ${key} failed`);
    }

    const response = responses.get(key);
    if (response) {
      return response;
    }

    return { stdout: '', stderr: '' };
  });

  const manager = createWorktreeManager({ repoRoot, execGit });

  function setResponse(args: string[], stdout: string): void {
    responses.set(args.join(' '), { stdout, stderr: '' });
  }

  function setFailure(args: string[]): void {
    failures.add(args.join(' '));
  }

  return { manager, execGit, calls, setResponse, setFailure, repoRoot };
}

// -- buildWorktreePath / buildBranchName --

test('it resolves the worktree path under the .worktrees directory for a given issue number', () => {
  const result = buildWorktreePath('/repo', 42);
  expect(result).toBe(resolve('/repo', '.worktrees', 'issue-42'));
});

test('it builds a branch name from an issue number', () => {
  expect(buildBranchName(42)).toBe('issue-42');
  expect(buildBranchName(1)).toBe('issue-1');
});

// -- createOrReuse: new worktree --

test('it creates a new worktree from main when no existing worktree or branch is found', async () => {
  const { manager, calls, setFailure } = setupTest();

  // worktree list returns only the main worktree (no match)
  // branch does not exist
  setFailure(['rev-parse', '--verify', 'refs/heads/issue-42']);

  const result = await manager.createOrReuse(42);

  expect(result.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-42'));
  expect(result.branch).toBe('issue-42');
  expect(result.created).toBe(true);

  // Should have called: worktree list, rev-parse, worktree add
  const addCall = calls.find(
    (c) => c.args[0] === 'worktree' && c.args[1] === 'add' && c.args[2] === '-b',
  );
  expect(addCall?.args).toStrictEqual([
    'worktree',
    'add',
    '-b',
    'issue-42',
    resolve('/repo', '.worktrees', 'issue-42'),
    'main',
  ]);
});

// -- createOrReuse: reuse existing worktree --

test('it reuses an existing registered worktree without creating a new one', async () => {
  const { manager, calls, setResponse } = setupTest();
  const worktreePath = resolve('/repo', '.worktrees', 'issue-7');

  // worktree list includes the worktree for issue-7
  setResponse(
    ['worktree', 'list', '--porcelain'],
    `worktree /repo\nbranch refs/heads/main\n\nworktree ${worktreePath}\nbranch refs/heads/issue-7\n`,
  );

  const result = await manager.createOrReuse(7);

  expect(result.worktreePath).toBe(worktreePath);
  expect(result.branch).toBe('issue-7');
  expect(result.created).toBe(false);

  // Should NOT have called worktree add
  const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
  expect(addCall).toBeUndefined();
});

// -- createOrReuse: branch exists but worktree was deleted --

test('it prunes and re-adds the worktree when the branch exists but the worktree is not registered', async () => {
  const { manager, calls } = setupTest();

  // worktree list returns only the main worktree (no match for issue-5)
  // branch DOES exist (rev-parse succeeds with default empty response)

  const result = await manager.createOrReuse(5);

  expect(result.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-5'));
  expect(result.branch).toBe('issue-5');
  expect(result.created).toBe(false);

  // Should have called prune then worktree add (without -b)
  const pruneCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'prune');
  expect(pruneCall).toBeDefined();

  const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
  expect(addCall?.args).toStrictEqual([
    'worktree',
    'add',
    resolve('/repo', '.worktrees', 'issue-5'),
    'issue-5',
  ]);
});

// -- remove --

test('it force-removes the worktree for a given issue number', async () => {
  const { manager, calls } = setupTest();

  await manager.remove(42);

  const removeCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
  expect(removeCall?.args).toStrictEqual([
    'worktree',
    'remove',
    resolve('/repo', '.worktrees', 'issue-42'),
    '--force',
  ]);
});

// -- createOrReuse returns correct path for different issue numbers --

test('it produces correct paths and branch names for various issue numbers', async () => {
  const { manager, setFailure } = setupTest();

  setFailure(['rev-parse', '--verify', 'refs/heads/issue-1']);
  const result1 = await manager.createOrReuse(1);
  expect(result1.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-1'));
  expect(result1.branch).toBe('issue-1');

  setFailure(['rev-parse', '--verify', 'refs/heads/issue-999']);
  const result999 = await manager.createOrReuse(999);
  expect(result999.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-999'));
  expect(result999.branch).toBe('issue-999');
});

// -- createOrReuse: git worktree add failure propagates --

test('it propagates git errors when creating a worktree fails', async () => {
  const { manager, setFailure } = setupTest();

  // branch doesn't exist
  setFailure(['rev-parse', '--verify', 'refs/heads/issue-10']);
  // worktree add fails
  setFailure([
    'worktree',
    'add',
    '-b',
    'issue-10',
    resolve('/repo', '.worktrees', 'issue-10'),
    'main',
  ]);

  await expect(manager.createOrReuse(10)).rejects.toThrow();
});

// -- remove: git worktree remove failure propagates --

test('it propagates git errors when removing a worktree fails', async () => {
  const { manager, setFailure } = setupTest();

  setFailure(['worktree', 'remove', resolve('/repo', '.worktrees', 'issue-99'), '--force']);

  await expect(manager.remove(99)).rejects.toThrow();
});

// -- createForBranch: fresh branch strategy --

test('it creates a new branch from a base when branchBase is provided', async () => {
  const { manager, calls } = setupTest();

  const result = await manager.createForBranch({
    branchName: 'issue-42-1739000000',
    branchBase: 'main',
  });

  expect(result.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-42-1739000000'));
  expect(result.branch).toBe('issue-42-1739000000');
  expect(result.created).toBe(true);

  const addCall = calls.find(
    (c) => c.args[0] === 'worktree' && c.args[1] === 'add' && c.args[2] === '-b',
  );
  expect(addCall?.args).toStrictEqual([
    'worktree',
    'add',
    '-b',
    'issue-42-1739000000',
    resolve('/repo', '.worktrees', 'issue-42-1739000000'),
    'main',
  ]);
});

// -- createForBranch: PR branch strategy --

test('it creates a worktree from an existing branch when no branchBase is provided', async () => {
  const { manager, calls } = setupTest();

  const result = await manager.createForBranch({
    branchName: 'issue-42-1738000000',
  });

  expect(result.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-42-1738000000'));
  expect(result.branch).toBe('issue-42-1738000000');
  expect(result.created).toBe(false);

  const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
  expect(addCall?.args).toStrictEqual([
    'worktree',
    'add',
    resolve('/repo', '.worktrees', 'issue-42-1738000000'),
    'issue-42-1738000000',
  ]);
});

// -- createForBranch: review branch strategy (fetchRemote) --

test('it fetches from origin and creates worktree at the remote tracking ref when fetchRemote is true', async () => {
  const { manager, calls } = setupTest();

  const result = await manager.createForBranch({
    branchName: 'issue-10-1739000000',
    fetchRemote: true,
  });

  expect(result.worktreePath).toBe(resolve('/repo', '.worktrees', 'issue-10-1739000000'));
  expect(result.branch).toBe('issue-10-1739000000');
  expect(result.created).toBe(true);

  const fetchCall = calls.find((c) => c.args[0] === 'fetch');
  expect(fetchCall?.args).toStrictEqual(['fetch', 'origin', 'issue-10-1739000000']);

  const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
  expect(addCall?.args).toStrictEqual([
    'worktree',
    'add',
    resolve('/repo', '.worktrees', 'issue-10-1739000000'),
    'origin/issue-10-1739000000',
  ]);
});

test('it runs fetch before worktree add when fetchRemote is true', async () => {
  const { manager, calls } = setupTest();

  await manager.createForBranch({
    branchName: 'issue-15-1739000000',
    fetchRemote: true,
  });

  const fetchIndex = calls.findIndex((c) => c.args[0] === 'fetch');
  const addIndex = calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'add');

  expect(fetchIndex).toBeGreaterThanOrEqual(0);
  expect(addIndex).toBeGreaterThanOrEqual(0);
  expect(fetchIndex).toBeLessThan(addIndex);
});

test('it does not fetch from remote when fetchRemote is false', async () => {
  const { manager, calls } = setupTest();

  await manager.createForBranch({
    branchName: 'issue-20-1739000000',
    fetchRemote: false,
  });

  const fetchCall = calls.find((c) => c.args[0] === 'fetch');
  expect(fetchCall).toBeUndefined();

  const addCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
  expect(addCall?.args).toStrictEqual([
    'worktree',
    'add',
    resolve('/repo', '.worktrees', 'issue-20-1739000000'),
    'issue-20-1739000000',
  ]);
});

test('it does not fetch from remote when fetchRemote is not provided', async () => {
  const { manager, calls } = setupTest();

  await manager.createForBranch({
    branchName: 'issue-25-1739000000',
  });

  const fetchCall = calls.find((c) => c.args[0] === 'fetch');
  expect(fetchCall).toBeUndefined();
});

// -- removeByPath --

test('it force-removes a worktree by its absolute path', async () => {
  const { manager, calls } = setupTest();

  await manager.removeByPath('/repo/.worktrees/issue-42-1739000000');

  const removeCall = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
  expect(removeCall?.args).toStrictEqual([
    'worktree',
    'remove',
    '/repo/.worktrees/issue-42-1739000000',
    '--force',
  ]);
});
