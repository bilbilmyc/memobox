export function verifyPublishedRelease(receipt: { version: string; integrity: string }, options?: {
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  wait?: (ms: number) => Promise<void>;
  attempts?: number;
  delayMs?: number;
}): Promise<void>;
