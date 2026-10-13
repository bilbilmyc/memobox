export type GitHubApi = (path: string, missing?: boolean) => Record<string, unknown> | Record<string, unknown>[] | null;
export function releaseCommit(api: GitHubApi, tag: string): Record<string, unknown> | null;
export function releaseForTag(api: GitHubApi, tag: string): Record<string, unknown> | null;
export function prepareRelease(api: GitHubApi, gh: (args: string[]) => unknown,
  options: { tag: string; revision: string; title: string; notesFile: string }): Record<string, unknown>;
