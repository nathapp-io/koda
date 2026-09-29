import type { Readable } from 'stream';

export const ARTIFACT_STORE = Symbol('ARTIFACT_STORE');

export class ArtifactTooLargeError extends Error {
  constructor() {
    super('artifact exceeds the size limit');
  }
}

export class ArtifactHashMismatchError extends Error {
  constructor() {
    super('artifact sha256 does not match');
  }
}

/** Spec §8 C6 seam: local disk in S1, object storage later. Keys are server-generated. */
export interface ArtifactStore {
  /** Atomic replace; on ArtifactTooLargeError or ArtifactHashMismatchError nothing is kept and the old object survives. */
  put(key: string, source: Readable, opts: { maxBytes: number; expectedSha256: string }): Promise<{ sizeBytes: number; sha256: string }>;
  get(key: string): Promise<Readable>;
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  delete(key: string): Promise<void>;
}
