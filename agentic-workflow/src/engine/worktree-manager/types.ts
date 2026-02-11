export interface WorktreeResult {
  worktreePath: string;
  branch: string;
  created: boolean; // true if newly created, false if reused
}

export type ExecGit = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeManagerDeps {
  repoRoot: string;
  execGit?: ExecGit;
}

export interface CreateForBranchParams {
  branchName: string;
  branchBase?: string; // present for fresh-branch strategy (new branch from base); absent for PR-branch strategy (existing branch)
  fetchRemote?: boolean; // when true, fetches from origin before creating worktree (review-branch strategy)
}

export interface WorktreeManager {
  createOrReuse: (issueNumber: number) => Promise<WorktreeResult>;
  createForBranch: (params: CreateForBranchParams) => Promise<WorktreeResult>;
  remove: (issueNumber: number) => Promise<void>;
  removeByPath: (worktreePath: string) => Promise<void>;
}
