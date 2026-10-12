export type GitHubApi = (path: string, missing?: boolean) => Record<string, unknown> | null;
export function releaseCommit(api: GitHubApi, tag: string): Record<string, unknown> | null;
