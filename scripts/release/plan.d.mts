export type ReleaseInput = {
  eventName: string;
  ref: string;
  repository: string;
  name: string;
  version: string;
  publishedVersions: string[];
  latest?: string;
  privatePackage?: boolean;
};
export type ReleasePlan = { publish: boolean; reason: string; version: string; tag: "latest" };
export function planRelease(input: ReleaseInput): ReleasePlan;
export function readRegistry(fetchFn?: (url: string, init?: RequestInit) => Promise<Response>): Promise<{ publishedVersions: string[]; latest?: string }>;
