import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  CreateForBranchParams,
  ExecGit,
  WorktreeManager,
  WorktreeManagerDeps,
  WorktreeResult,
} from './types.ts';

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const { repoRoot } = deps;
  const execGit: ExecGit =
    deps.execGit ??
    ((args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync('git', args, { cwd: repoRoot }));

  async function listWorktrees(): Promise<string[]> {
    const { stdout } = await execGit(['worktree', 'list', '--porcelain']);
    const paths: string[] = [];
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        paths.push(line.slice('worktree '.length));
      }
    }
    return paths;
  }

  async function branchExists(branch: string): Promise<boolean> {
    try {
      await execGit(['rev-parse', '--verify', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async function worktreeIsRegistered(worktreePath: string): Promise<boolean> {
    const paths = await listWorktrees();
    return paths.includes(worktreePath);
  }

  return {
    async createOrReuse(issueNumber: number): Promise<WorktreeResult> {
      const worktreePath = buildWorktreePath(repoRoot, issueNumber);
      const branch = buildBranchName(issueNumber);

      const registered = await worktreeIsRegistered(worktreePath);
      if (registered) {
        return { worktreePath, branch, created: false };
      }

      const hasBranch = await branchExists(branch);

      if (hasBranch) {
        // Branch exists but worktree is not registered.
        // This can happen when the worktree directory was manually deleted.
        // Prune stale worktree entries, then re-add pointing at the existing branch.
        await execGit(['worktree', 'prune']);
        await execGit(['worktree', 'add', worktreePath, branch]);
        return { worktreePath, branch, created: false };
      }

      // Fresh: create a new branch from main and attach it to a new worktree.
      await execGit(['worktree', 'add', '-b', branch, worktreePath, 'main']);
      return { worktreePath, branch, created: true };
    },

    async createForBranch(params: CreateForBranchParams): Promise<WorktreeResult> {
      const worktreePath = resolve(repoRoot, '.worktrees', params.branchName);

      if (params.branchBase !== undefined) {
        // Fresh branch strategy: create new branch from base
        await execGit([
          'worktree',
          'add',
          '-b',
          params.branchName,
          worktreePath,
          params.branchBase,
        ]);
        return { worktreePath, branch: params.branchName, created: true };
      }

      if (params.fetchRemote === true) {
        // Review branch strategy: fetch from remote then create worktree at remote tracking ref
        await execGit(['fetch', 'origin', params.branchName]);
        await execGit(['worktree', 'add', worktreePath, `origin/${params.branchName}`]);
        return { worktreePath, branch: params.branchName, created: true };
      }

      // PR branch strategy: use existing branch
      await execGit(['worktree', 'add', worktreePath, params.branchName]);
      return { worktreePath, branch: params.branchName, created: false };
    },

    async remove(issueNumber: number): Promise<void> {
      const worktreePath = buildWorktreePath(repoRoot, issueNumber);
      await execGit(['worktree', 'remove', worktreePath, '--force']);
    },

    async removeByPath(worktreePath: string): Promise<void> {
      await execGit(['worktree', 'remove', worktreePath, '--force']);
    },
  };
}

export function buildWorktreePath(repoRoot: string, issueNumber: number): string {
  return resolve(repoRoot, '.worktrees', `issue-${issueNumber}`);
}

export function buildBranchName(issueNumber: number): string {
  return `issue-${issueNumber}`;
}
