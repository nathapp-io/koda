import { createHash } from 'node:crypto';

export interface RefreshClient {
  uaHash: string;
  ip: string | null;
}

export interface RefreshRequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

export function refreshClientOf(userAgent: string | undefined, ip: string | undefined): RefreshClient {
  return {
    uaHash: createHash('sha256').update(userAgent ?? '').digest('hex'),
    ip: ip || null,
  };
}
