import { posix } from 'path';
import type { Readable } from 'stream';
import { extract, type Header } from 'tar-stream';
import { createGunzip } from 'zlib';
import type { LogStreamName } from './domain/fleet-job-log.domain';

export interface BundleMember {
  name: string;
  size: number;
  mtimeMs: number;
}

const normalise = (name: string): string => name.replace(/^\.\//, '');

/**
 * Plan D316: walks the archive; `onFile` gets each regular file; every entry is drained.
 * tar-stream 3 entries are streamx streams: `readableEnded` does not exist and `end` may fire before `onFile`
 * resolves, so advance on `close` (fires after end or destroy), attached synchronously, at most once.
 */
function walk(bundle: Readable, onFile: (h: Header, member: BundleMember, entry: Readable) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const x = extract();
    const fail = (error: Error) => {
      bundle.destroy();
      reject(error);
    };
    x.on('entry', (header, entry, next) => {
      const member = { name: normalise(header.name), size: header.size ?? 0, mtimeMs: header.mtime?.getTime() ?? 0 };
      let advanced = false;
      const advance = () => {
        if (!advanced) {
          advanced = true;
          next();
        }
      };
      entry.once('close', advance);
      if (header.type !== 'file') {
        entry.resume();
        return;
      }
      onFile(header, member, entry as unknown as Readable).then(() => entry.resume(), (error: unknown) => x.destroy(error as Error));
    });
    x.on('finish', resolve);
    x.on('error', fail);
    const gunzip = createGunzip();
    gunzip.on('error', fail);
    bundle.on('error', fail);
    bundle.pipe(gunzip).pipe(x as unknown as NodeJS.WritableStream);
  });
}

export async function listBundleMembers(bundle: Readable): Promise<BundleMember[]> {
  const found: BundleMember[] = [];
  await walk(bundle, async (_h, member, entry) => {
    found.push(member);
    entry.resume();
  });
  return found;
}

/** Spec §2.5 step 1, plan D317. */
export function pickLogMembers(
  members: readonly BundleMember[],
  job: { command: string; feature: string; naxLogRunId: string | null },
): Partial<Record<LogStreamName, BundleMember>> {
  const byName = new Map(members.map((m) => [m.name, m]));
  const stdout = byName.get('nax.stdout');
  const stderr = byName.get('nax.stderr');
  const base = { ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) };
  if (job.command !== 'RUN') return base;
  const dir = `nax-out/features/${job.feature}/runs`;
  const candidates = members.filter((m) => posix.dirname(m.name) === dir && m.name.endsWith('.jsonl') && posix.basename(m.name) !== 'latest.jsonl');
  const byId = job.naxLogRunId ? byName.get(`${dir}/${job.naxLogRunId}.jsonl`) : undefined;
  const newest = [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0];
  const run = byId ?? (candidates.length === 1 ? candidates[0] : newest);
  return run ? { ...base, run } : base;
}

export async function extractBundleMembers(
  bundle: Readable,
  wanted: ReadonlyMap<string, LogStreamName>,
  sink: (stream: LogStreamName, entry: Readable, member: BundleMember) => Promise<void>,
): Promise<void> {
  await walk(bundle, async (_h, member, entry) => {
    const stream = wanted.get(member.name);
    if (stream) await sink(stream, entry, member);
    else entry.resume();
  });
}
