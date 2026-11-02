import type { Readable } from 'stream';
import { extract } from 'tar-stream';
import { createGunzip } from 'zlib';
import { INGEST_LIMITS } from './domain/bundle-ingest.domain';

export interface BundleFile {
  name: string;
  text: string;
}

export interface BundleFiles {
  cost: BundleFile[];
  metrics: BundleFile | null;
  reviews: BundleFile[];
  finishResults: BundleFile[];
  finishLast: BundleFile[];
  status: BundleFile | null;
  workflowResult: BundleFile | null;
  /** S5b 3c-2-D1: the RUN's feature report; optional so pre-existing literals stay valid. */
  featureReport?: BundleFile | null;
  /** S5b 3c-2-D1: the RUN's decisions log; optional so pre-existing literals stay valid. */
  decisions?: BundleFile | null;
  /** Review artifact(s), optional for compatibility with existing literals. */
  botReview?: BundleFile[];
  /** Nax stdout, optional for compatibility with existing literals. */
  naxStdout?: BundleFile | null;
  oversized: string[];
}

type Slot = 'cost' | 'metrics' | 'reviews' | 'finishResults' | 'finishLast' | 'status' | 'workflowResult' | 'featureReport' | 'decisions' | 'botReview' | 'naxStdout';

const SLOTS: ReadonlyArray<[RegExp, Slot]> = [
  [/^nax-out\/bot\/pr-[1-9]\d*\/[^/]+\/bot-review\.json$/, 'botReview'],
  [/^nax\.stdout$/, 'naxStdout'],
  [/^nax-out\/cost\/[^/]+\.jsonl$/, 'cost'],
  [/^nax-out\/metrics\.json$/, 'metrics'],
  [/^nax-out\/review-audit\/[^/]+\/[^/]+\.json$/, 'reviews'],
  [/^nax-out\/finish-audit\/[^/]+\/[^/]+\.result\.json$/, 'finishResults'],
  [/^nax-out\/finish-audit\/[^/]+\/last\.json$/, 'finishLast'],
  [/^nax-out\/status\.json$/, 'status'],
  [/^workflow\/result\.json$/, 'workflowResult'],
  [/^workflow\/feature-report\.md$/, 'featureReport'],
  [/^workflow\/decisions\.jsonl$/, 'decisions'],
];

/** Spec §2.3: the allowlisted slot of a tar entry name, or null for anything else (including unsafe names). */
export function slotOf(rawName: string): Slot | null {
  const name = rawName.replace(/^\.\//, '');
  if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) return null;
  const hit = SLOTS.find(([re]) => re.test(name));
  return hit ? hit[1] : null;
}

function readEntry(entry: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    entry.on('data', (c: Buffer) => chunks.push(c));
    entry.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    entry.on('error', reject);
  });
}

/**
 * Whole-branch fix B2: `oversized` is a partial-outcome signal (`parseBundle` reads its length and its
 * slot prefixes), not a manifest of the archive, so it keeps at most this many names. A bundle of
 * zero-byte entries passes the byte budgets and is rejected by the per-slot cap instead, and an
 * unbounded list made every one of those rejections copy the whole array.
 */
export const MAX_OVERSIZED_NAMES = 64;

/**
 * Whole-branch fix B2: the entry ceiling. `fileBytes`, `totalBytes` and `maxFilesPerSlot` bound what is
 * kept, never what is read, and a gzip of zero-byte entries expands about a thousandfold: a 32 MiB
 * upload can carry tens of millions of entries this reader would otherwise parse one by one. Past this
 * many entries the archive is not a bundle, so reading stops and the outcome stays partial.
 */
export const MAX_BUNDLE_ENTRIES = 100_000;

/** The name the entry ceiling records; it matches no slot prefix, so it only makes the outcome partial. */
export const ENTRY_LIMIT_EXCEEDED = 'bundle/entry-limit-exceeded';

/** What the reader bounds; `maxEntries` is a test seam (`INGEST_LIMITS` leaves it at the ceiling). */
export type BundleReadLimits = Readonly<Record<'fileBytes' | 'totalBytes' | 'maxFilesPerSlot', number>> & {
  maxEntries?: number;
};

/**
 * Streams the bundle once; keeps the text of allowlisted regular files up to INGEST_LIMITS.fileBytes,
 * the total kept bytes and the files per slot, and stops at the entry ceiling.
 * tar-stream 3 entries are streamx streams: advance on `close`, after the entry was consumed (see
 * src/fleet/logs/bundle-log-extractor.ts for the same rule).
 */
export function readBundleFiles(
  bundle: Readable,
  limits: BundleReadLimits = INGEST_LIMITS,
): Promise<BundleFiles> {
  return new Promise((resolve, reject) => {
    const acc = { cost: [] as BundleFile[], metrics: null as BundleFile | null, reviews: [] as BundleFile[], finishResults: [] as BundleFile[], finishLast: [] as BundleFile[], status: null as BundleFile | null, workflowResult: null as BundleFile | null, featureReport: null as BundleFile | null, decisions: null as BundleFile | null, botReview: [] as BundleFile[], naxStdout: null as BundleFile | null, oversized: [] as string[] };
    let keptBytes = 0;
    let examined = 0;
    let settled = false;
    const keptFilesPerSlot: Partial<Record<Slot, number>> = {};
    const maxEntries = limits.maxEntries ?? MAX_BUNDLE_ENTRIES;
    const x = extract();
    const gunzip = createGunzip();
    // Grows in place: appending with a spread copies the whole list for every rejected entry.
    const recordOversized = (name: string) => {
      if (acc.oversized.length < MAX_OVERSIZED_NAMES) acc.oversized.push(name);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve(acc);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      bundle.destroy();
      reject(error);
    };
    x.on('entry', (header, entry, next) => {
      const body = entry as unknown as Readable;
      body.once('close', () => next());
      examined += 1;
      if (examined > maxEntries) {
        // Past the ceiling the archive is not a bundle: stop the work here instead of parsing millions
        // of headers that no slot would keep, and report the outcome partial. Destroying the piped
        // streams is what ends the reads; the entry never advances and no name is buffered.
        recordOversized(ENTRY_LIMIT_EXCEEDED);
        bundle.destroy();
        gunzip.destroy();
        x.destroy();
        settle();
        return;
      }
      const slot = header.type === 'file' ? slotOf(header.name) : null;
      const name = header.name.replace(/^\.\//, '');
      if (!slot) {
        body.resume();
        return;
      }
      const size = header.size ?? 0;
      const arraySlot = slot === 'cost' || slot === 'reviews' || slot === 'finishResults' || slot === 'finishLast' || slot === 'botReview';
      const skip = size > limits.fileBytes
        || (arraySlot && (keptFilesPerSlot[slot] ?? 0) >= limits.maxFilesPerSlot)
        || keptBytes + size > limits.totalBytes;
      if (skip) {
        if (slot !== 'botReview' && slot !== 'naxStdout') recordOversized(name);
        body.resume();
        return;
      }
      keptBytes += size;
      if (arraySlot) keptFilesPerSlot[slot] = (keptFilesPerSlot[slot] ?? 0) + 1;
      readEntry(body).then((text) => {
        const file = { name, text };
        if (slot === 'metrics') acc.metrics = file;
        else if (slot === 'status') acc.status = file;
        else if (slot === 'workflowResult') acc.workflowResult = file;
        else if (slot === 'featureReport') acc.featureReport = file;
        else if (slot === 'decisions') acc.decisions = file;
        else if (slot === 'naxStdout') acc.naxStdout = file;
        else acc[slot] = [...acc[slot], file];
      }, (error: unknown) => x.destroy(error as Error));
    });
    x.on('finish', settle);
    x.on('error', fail);
    gunzip.on('error', fail);
    bundle.on('error', fail);
    bundle.pipe(gunzip).pipe(x as unknown as NodeJS.WritableStream);
  });
}
