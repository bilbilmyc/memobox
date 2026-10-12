export type PlatformAsset = { version: string; filename: string; asset: string; sha256: string; compressedSha256: string; size: number; compressedSize: number };
export type Manifest = { version: string; platforms: Record<string, PlatformAsset> };
export function platformAsset(manifest: Manifest, platform?: string, arch?: string): PlatformAsset & { key: string };
export function fileHash(path: string): Promise<string>;
export function ensureBinary(manifest: Manifest, options?: { platform?: string; arch?: string; override?: string; cache?: string; base?: string; progress?: (message: string) => void }): Promise<string>;
