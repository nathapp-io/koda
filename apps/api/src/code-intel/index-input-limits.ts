/**
 * Input limits for commit indexing (#534).
 *
 * A push event lists every changed path, and the extractor runs the TypeScript compiler inside the API process.
 * These limits keep what reaches it to source it can parse, in batches of bounded size.
 */

/** The extensions `CodeGraphService` extracts symbols from. Anything else is never fetched. */
const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']);

/** One file's cap, the same as the knowledge indexer's `MAX_KNOWLEDGE_FILE_BYTES`. */
export const MAX_INDEX_FILE_BYTES = 262_144;

/** The files one extraction batch may hold. */
export const MAX_INDEX_BATCH_FILES = 100;

/** The source bytes one extraction batch may hold. */
export const MAX_INDEX_BATCH_BYTES = 2 * 1024 * 1024;

export interface IndexSourceFile {
  path: string;
  content: string;
}

export function isIndexablePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return INDEXABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Splits fetched files into those small enough to parse and the paths of those that are not. */
export function partitionBySize<T extends IndexSourceFile>(files: readonly T[]): { accepted: T[]; oversized: string[] } {
  return {
    accepted: files.filter((file) => Buffer.byteLength(file.content, 'utf8') <= MAX_INDEX_FILE_BYTES),
    oversized: files.filter((file) => Buffer.byteLength(file.content, 'utf8') > MAX_INDEX_FILE_BYTES).map((file) => file.path),
  };
}

/**
 * Groups files, in order, into batches within the file and byte caps. Every file is at most
 * `MAX_INDEX_FILE_BYTES` (see `partitionBySize`), so a single file always fits a batch.
 */
export function batchSourceFiles<T extends IndexSourceFile>(files: readonly T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (current.length > 0 && (current.length >= MAX_INDEX_BATCH_FILES || currentBytes + bytes > MAX_INDEX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
