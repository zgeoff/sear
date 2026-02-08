// Narrow interface over @octokit/rest's Octokit client. Only the methods and
// response shapes actually used by production code are declared here, which
// keeps tests type-safe without casts — mocks satisfy this interface naturally
// while Octokit's deeply generic types would require `as never` everywhere.

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export type IssuesGetParams = {
  owner: string;
  repo: string;
  issue_number: number;
};

export type IssueData = {
  number: number;
  title: string;
  body: string | null;
  labels: (string | { name?: string })[];
  created_at: string;
};

export type IssuesGetResult = {
  data: IssueData;
};

// ---------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------

export type PullsListParams = {
  owner: string;
  repo: string;
  state: string;
  per_page: number;
};

export type PullsListItem = {
  number: number;
  body: string | null;
};

export type PullsListResult = {
  data: PullsListItem[];
};

export type PullsGetParams = {
  owner: string;
  repo: string;
  pull_number: number;
};

export type PullData = {
  number: number;
  title: string;
  changed_files: number;
  html_url: string;
  head: { sha: string };
};

export type PullsGetResult = {
  data: PullData;
};

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export type ReposGetCombinedStatusParams = {
  owner: string;
  repo: string;
  ref: string;
};

export type CombinedStatusData = {
  state: string;
  total_count: number;
};

export type ReposGetCombinedStatusResult = {
  data: CombinedStatusData;
};

export type ReposGetContentParams = {
  owner: string;
  repo: string;
  path: string;
  ref: string;
};

export type ReposGetContentResult = {
  data: { content?: string };
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type ChecksListForRefParams = {
  owner: string;
  repo: string;
  ref: string;
};

export type CheckRun = {
  status: string;
  conclusion: string | null;
};

export type ChecksListForRefResult = {
  data: {
    total_count: number;
    check_runs: CheckRun[];
  };
};

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export type GitGetTreeParams = {
  owner: string;
  repo: string;
  tree_sha: string;
  recursive?: string;
};

export type TreeEntry = {
  path?: string;
  sha?: string;
  type?: string;
};

export type GitGetTreeResult = {
  data: {
    sha: string;
    tree: TreeEntry[];
  };
};

export type GitGetRefParams = {
  owner: string;
  repo: string;
  ref: string;
};

export type GitGetRefResult = {
  data: {
    object: { sha: string };
  };
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type GitHubClient = {
  issues: {
    get(params: IssuesGetParams): Promise<IssuesGetResult>;
  };
  pulls: {
    list(params: PullsListParams): Promise<PullsListResult>;
    get(params: PullsGetParams): Promise<PullsGetResult>;
  };
  repos: {
    getCombinedStatusForRef(
      params: ReposGetCombinedStatusParams,
    ): Promise<ReposGetCombinedStatusResult>;
    getContent(params: ReposGetContentParams): Promise<ReposGetContentResult>;
  };
  checks: {
    listForRef(params: ChecksListForRefParams): Promise<ChecksListForRefResult>;
  };
  git: {
    getTree(params: GitGetTreeParams): Promise<GitGetTreeResult>;
    getRef(params: GitGetRefParams): Promise<GitGetRefResult>;
  };
};
