// Narrow interface over @octokit/rest's Octokit client. Only the methods and
// response shapes actually used by production code are declared here, which
// keeps tests type-safe without casts — mocks satisfy this interface naturally
// while Octokit's deeply generic types would require `as never` everywhere.
//
// Param interfaces include `[key: string]: unknown` so they satisfy Octokit's
// `RequestParameters` index signature without casts at the call site.

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export interface IssuesGetParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  issue_number: number;
}

export interface IssueData {
  number: number;
  title: string;
  body: string | null;
  labels: (string | { name?: string })[];
  created_at: string;
}

export interface IssuesGetResult {
  data: IssueData;
}

export interface IssuesListForRepoParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  labels: string;
  state: 'open' | 'closed' | 'all';
  per_page: number;
}

export interface IssuesListForRepoResult {
  data: IssueData[];
}

export interface IssuesAddLabelsParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  issue_number: number;
  labels: string[];
}

export interface IssuesAddLabelsResult {
  data: unknown;
}

export interface IssuesRemoveLabelParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  issue_number: number;
  name: string;
}

export interface IssuesRemoveLabelResult {
  data: unknown;
}

// ---------------------------------------------------------------------------
// Pulls
// ---------------------------------------------------------------------------

export interface PullsListParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  state: 'open' | 'closed' | 'all';
  per_page: number;
}

export interface PullsListItem {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  head: PullHeadRef;
  body: string | null;
  draft: boolean;
}

export interface PullsListResult {
  data: PullsListItem[];
}

export interface PullsGetParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  pull_number: number;
}

export interface PullHeadRef {
  sha: string;
  ref: string;
}

export interface PullData {
  number: number;
  title: string;
  changed_files: number;
  html_url: string;
  head: PullHeadRef;
  draft: boolean;
}

export interface PullsGetResult {
  data: PullData;
}

export interface PullsListFilesParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  pull_number: number;
  per_page: number;
}

export interface PullFileEntry {
  filename: string;
  status: string;
  patch?: string;
}

export interface PullsListFilesResult {
  data: PullFileEntry[];
}

export interface PullsListReviewsParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  pull_number: number;
  per_page: number;
}

export interface PullReview {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
}

export interface PullsListReviewsResult {
  data: PullReview[];
}

export interface PullsListReviewCommentsParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  pull_number: number;
  per_page: number;
}

export interface PullReviewComment {
  id: number;
  user: { login: string } | null;
  body: string | null;
  path: string;
  line: number | null;
}

export interface PullsListReviewCommentsResult {
  data: PullReviewComment[];
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export interface ReposGetCombinedStatusParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  ref: string;
}

export interface CombinedStatusData {
  state: string;
  total_count: number;
}

export interface ReposGetCombinedStatusResult {
  data: CombinedStatusData;
}

export interface ReposGetContentParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export interface ReposContentData {
  content?: string;
}

export interface ReposGetContentResult {
  data: ReposContentData;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export interface ChecksListForRefParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  ref: string;
}

export interface CheckRun {
  name?: string;
  status: string;
  conclusion: string | null;
  details_url?: string;
}

export interface ChecksListForRefData {
  total_count: number;
  check_runs: CheckRun[];
}

export interface ChecksListForRefResult {
  data: ChecksListForRefData;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitGetTreeParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  tree_sha: string;
  recursive?: string;
}

export interface TreeEntry {
  path?: string;
  sha?: string;
  type?: string;
}

export interface GitTreeData {
  sha: string;
  tree: TreeEntry[];
}

export interface GitGetTreeResult {
  data: GitTreeData;
}

export interface GitGetRefParams {
  [key: string]: unknown;
  owner: string;
  repo: string;
  ref: string;
}

export interface GitRefObject {
  sha: string;
}

export interface GitRefData {
  object: GitRefObject;
}

export interface GitGetRefResult {
  data: GitRefData;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface GitHubClientConfig {
  appID: number;
  privateKey: string;
  installationID: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface GitHubClient {
  issues: {
    get: (params: IssuesGetParams) => Promise<IssuesGetResult>;
    listForRepo: (params: IssuesListForRepoParams) => Promise<IssuesListForRepoResult>;
    addLabels: (params: IssuesAddLabelsParams) => Promise<IssuesAddLabelsResult>;
    removeLabel: (params: IssuesRemoveLabelParams) => Promise<IssuesRemoveLabelResult>;
  };
  pulls: {
    list: (params: PullsListParams) => Promise<PullsListResult>;
    get: (params: PullsGetParams) => Promise<PullsGetResult>;
    listFiles: (params: PullsListFilesParams) => Promise<PullsListFilesResult>;
    listReviews: (params: PullsListReviewsParams) => Promise<PullsListReviewsResult>;
    listReviewComments: (
      params: PullsListReviewCommentsParams,
    ) => Promise<PullsListReviewCommentsResult>;
  };
  repos: {
    getCombinedStatusForRef: (
      params: ReposGetCombinedStatusParams,
    ) => Promise<ReposGetCombinedStatusResult>;
    getContent: (params: ReposGetContentParams) => Promise<ReposGetContentResult>;
  };
  checks: {
    listForRef: (params: ChecksListForRefParams) => Promise<ChecksListForRefResult>;
  };
  git: {
    getTree: (params: GitGetTreeParams) => Promise<GitGetTreeResult>;
    getRef: (params: GitGetRefParams) => Promise<GitGetRefResult>;
  };
}
