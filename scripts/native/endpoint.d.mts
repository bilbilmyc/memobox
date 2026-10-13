export function validateEndpoint(command: string, prefix: string[], root: string,
  inherited: Record<string, string | undefined>, options?: { responseDelayMs?: number }): Promise<boolean>;
