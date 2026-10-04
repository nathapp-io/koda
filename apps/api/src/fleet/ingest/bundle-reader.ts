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
  oversized: string[];
}

type Slot = 'cost' | 'metrics' | 'reviews' | 'finishResults' | 'finishLast' | 'status';

const SLOTS: ReadonlyArray<[RegExp, Slot]> = [
  [/^nax-out\/cost\/[^/]+\.jsonl$/, 'cost'],
  [/^nax-out\/metrics\.json$/, 'metrics'],
  [/^nax-out\/review-audit\/[^/]+\/[^/]+\.json$/, 'reviews'],
  [/^nax-out\/finish-audit\/[^/]+\/[^/]+\.result\.json$/, 'finishResults'],
  [/^nax-out\/finish-audit\/[^/]+\/last\.json$/, 'finishLast'],
  [/^nax-out\/status\.json$/, 'status'],
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
 * Streams the bundle once; keeps the text of allowlisted regular files up to INGEST_LIMITS.fileBytes.
 * tar-stream 3 entries are streamx streams: advance on `close`, after the entry was consumed (see
 * src/fleet/logs/bundle-log-extractor.ts for the same rule).
 */
export function readBundleFiles(bundle: Readable): Promise<BundleFiles> {
  return new Promise((resolve, reject) => {
    const acc = { cost: [] as BundleFile[], metrics: null as BundleFile | null, reviews: [] as BundleFile[], finishResults: [] as BundleFile[], finishLast: [] as BundleFile[], status: null as BundleFile | null, oversized: [] as string[] };
    const x = extract();
    const fail = (error: Error) => {
      bundle.destroy();
      reject(error);
    };
    x.on('entry', (header, entry, next) => {
      const body = entry as unknown as Readable;
      body.once('close', () => next());
      const slot = header.type === 'file' ? slotOf(header.name) : null;
      const name = header.name.replace(/^\.\//, '');
      if (!slot) {
        body.resume();
        return;
      }
      if ((header.size ?? 0) > INGEST_LIMITS.fileBytes) {
        acc.oversized = [...acc.oversized, name];
        body.resume();
        return;
      }
      readEntry(body).then((text) => {
        const file = { name, text };
        if (slot === 'metrics') acc.metrics = file;
        else if (slot === 'status') acc.status = file;
        else acc[slot] = [...acc[slot], file];
      }, (error: unknown) => x.destroy(error as Error));
    });
    x.on('finish', () => resolve(acc));
    x.on('error', fail);
    const gunzip = createGunzip();
    gunzip.on('error', fail);
    bundle.on('error', fail);
    bundle.pipe(gunzip).pipe(x as unknown as NodeJS.WritableStream);
  });
}
