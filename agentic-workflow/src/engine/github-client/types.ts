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

export type IssuesListForRepoParams = {
  owner: string;
  repo: string;
  labels: string;
  state: string;
  per_page: number;
};

export type IssuesListForRepoResult = {
  data: IssueData[];
};

export type IssuesAddLabelsParams = {
  owner: string;
  repo: string;
  issue_number: number;
  labels: string[];
};

export type IssuesAddLabelsResult = {
  data: unknown;
};

export type IssuesRemoveLabelParams = {
  owner: string;
  repo: string;
  issue_number: number;
  name: string;
};

export type IssuesRemoveLabelResult = {
  data: unknown;
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

export type PullHeadRef = {
  sha: string;
};

export type PullData = {
  number: number;
  title: string;
  changed_files: number;
  html_url: string;
  head: PullHeadRef;
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

export type ReposContentData = {
  content?: string;
};

export type ReposGetContentResult = {
  data: ReposContentData;
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

export type ChecksListForRefData = {
  total_count: number;
  check_runs: CheckRun[];
};

export type ChecksListForRefResult = {
  data: ChecksListForRefData;
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

export type GitTreeData = {
  sha: string;
  tree: TreeEntry[];
};

export type GitGetTreeResult = {
  data: GitTreeData;
};

export type GitGetRefParams = {
  owner: string;
  repo: string;
  ref: string;
};

export type GitRefObject = {
  sha: string;
};

export type GitRefData = {
  object: GitRefObject;
};

export type GitGetRefResult = {
  data: GitRefData;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type GitHubClient = {
  issues: {
    get(params: IssuesGetParams): Promise<IssuesGetResult>;
    listForRepo(params: IssuesListForRepoParams): Promise<IssuesListForRepoResult>;
    addLabels(params: IssuesAddLabelsParams): Promise<IssuesAddLabelsResult>;
    removeLabel(params: IssuesRemoveLabelParams): Promise<IssuesRemoveLabelResult>;
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
