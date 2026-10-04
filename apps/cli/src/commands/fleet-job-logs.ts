import { Command, InvalidArgumentError } from 'commander';
import {
  fleetJobLogsControllerEntries,
  fleetJobLogsControllerList,
  fleetJobsControllerGet,
  type FleetJobDto,
  type FleetJobLogEntriesDto,
  type FleetJobLogEntryDto,
  type FleetJobLogListDto,
  type FleetJobLogsControllerEntriesData,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';

const STREAMS = ['run', 'stdout', 'stderr'] as const;
type Stream = (typeof STREAMS)[number];
type EntriesQuery = NonNullable<FleetJobLogsControllerEntriesData['query']>;
type Level = NonNullable<EntriesQuery['level']>;
const LEVELS: readonly Level[] = ['debug', 'info', 'warn', 'error'];
const TERMINAL: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED']);
const POLL_MS = 2000;
const STATE_CHECK_EVERY = 10;
const PAGE_LIMIT = 500;

export function parseStream(value: string): Stream {
  if (!(STREAMS as readonly string[]).includes(value)) throw new InvalidArgumentError('expected run, stdout or stderr');
  return value as Stream;
}

export function parseLevel(value: string): Level {
  if (!(LEVELS as readonly string[]).includes(value)) throw new InvalidArgumentError('expected debug, info, warn or error');
  return value as Level;
}

export function parseEpoch(value: string): number {
  if (!/^\d{1,9}$/.test(value.trim())) throw new InvalidArgumentError('must be a whole number, 0 or more');
  return Number(value.trim());
}

/** D347: `HH:MM:SS LEVEL [stage] [story] message` for a parsed run line; the raw text otherwise. */
export function formatEntry(stream: Stream, e: FleetJobLogEntryDto): string {
  if (stream !== 'run' || e.unparsed || !e.level) return e.text ?? '';
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(e.timestamp ?? '')?.[1] ?? '--:--:--';
  const parts = [time, e.level.toUpperCase().padEnd(5), e.stage ? `[${e.stage}]` : null, e.storyId ? `[${e.storyId}]` : null, e.message ?? ''];
  return parts.filter((p): p is string => p !== null).join(' ');
}

export interface LogsOptions {
  project?: string;
  stream: Stream;
  leaseEpoch?: number;
  follow?: boolean;
  level?: Level;
  story?: string;
  stage?: string;
  role?: string;
  grep?: string;
  json?: boolean;
}

/** Seams for tests: the poll sleep, the output line, and the follow-mode Ctrl-C hook. */
export interface LogsDeps {
  sleep(ms: number): Promise<void>;
  print(line: string): void;
  onInterrupt(handler: () => void): void;
}

const defaultDeps: LogsDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  print: (line) => console.log(line),
  // D346: runs before the global SIGINT handler (exit 130), so Ctrl-C ends a follow with 0.
  onInterrupt: (handler) => { process.prependListener('SIGINT', handler); },
};

interface Target {
  slug: string;
  jobId: string;
  stream: Stream;
  leaseEpoch?: number;
}

function entriesQuery(t: Target, o: LogsOptions, cursor: number): EntriesQuery {
  return {
    cursor, direction: 'forward', limit: PAGE_LIMIT,
    ...(t.leaseEpoch !== undefined ? { leaseEpoch: t.leaseEpoch } : {}),
    ...(o.level ? { level: o.level } : {}),
    ...(o.story ? { storyId: o.story } : {}),
    ...(o.stage ? { stage: o.stage } : {}),
    ...(o.role ? { role: o.role } : {}),
    ...(o.grep ? { q: o.grep } : {}),
  };
}

async function fetchPage(t: Target, o: LogsOptions, cursor: number): Promise<FleetJobLogEntriesDto> {
  return unwrap<FleetJobLogEntriesDto>(await fleetJobLogsControllerEntries({
    path: { slug: t.slug, id: t.jobId, stream: t.stream },
    query: entriesQuery(t, o, cursor),
  }));
}

/** D347: the newest attempt that has logs; undefined lets the server use the job's current epoch. */
async function latestEpoch(slug: string, jobId: string): Promise<number | undefined> {
  const list = unwrap<FleetJobLogListDto>(await fleetJobLogsControllerList({ path: { slug, id: jobId } }));
  return list.attempts[0]?.leaseEpoch;
}

async function jobIsTerminal(t: Target): Promise<boolean> {
  const job = unwrap<FleetJobDto>(await fleetJobsControllerGet({ path: { slug: t.slug, id: t.jobId } }));
  return TERMINAL.has(job.state);
}

/**
 * Spec §3.4, D346: print the stream from offset 0. Without follow, stop at the end. With follow, poll every
 * 2 s while at the end; stop when the stream is complete or truncated, or when the job is terminal (checked
 * every 10th sleep, then one more page).
 */
export async function streamLogs(t: Target, o: LogsOptions, deps: LogsDeps): Promise<void> {
  let cursor = 0;
  let sleeps = 0;
  let terminal = false;
  for (;;) {
    const page = await fetchPage(t, o, cursor);
    for (const e of page.entries) deps.print(o.json ? JSON.stringify(e) : formatEntry(t.stream, e));
    const moved = page.nextCursor !== cursor;
    cursor = page.nextCursor;
    if (!page.atEnd && moved) continue;
    if (!o.follow || page.complete || page.truncated || terminal) return;
    sleeps += 1;
    if (sleeps % STATE_CHECK_EVERY === 0 && (await jobIsTerminal(t))) {
      terminal = true;
      continue;
    }
    await deps.sleep(POLL_MS);
  }
}

export function registerLogs(job: Command, deps: LogsDeps = defaultDeps): void {
  job
    .command('logs <jobId>')
    .description("Print a job's log stream (nax run JSONL, stdout or stderr); --follow keeps polling")
    .option('--stream <stream>', 'run, stdout or stderr', parseStream, 'run')
    .option('--lease-epoch <n>', 'Attempt (default: the latest attempt with logs)', parseEpoch)
    .option('--follow', 'Keep polling until the stream is complete or the job has ended')
    .option('--level <level>', 'Minimum level: debug, info, warn or error (run stream)', parseLevel)
    .option('--story <id>', 'Only this story (run stream)')
    .option('--stage <stage>', 'Only this stage (run stream)')
    .option('--role <role>', 'Only this session role (run stream)')
    .option('--grep <text>', 'Case-insensitive substring of the raw line')
    .option('--project <slug>', 'Project slug (uses config if not provided)')
    .option('--json', 'One JSON object per entry (NDJSON)')
    .action(async (jobId: string, options: LogsOptions) => {
      try {
        const { projectSlug: slug } = await withContext({ projectSlug: options.project });
        const leaseEpoch = options.leaseEpoch ?? (await latestEpoch(slug, jobId));
        if (options.follow) deps.onInterrupt(() => process.exit(0));
        await streamLogs({ slug, jobId, stream: options.stream, leaseEpoch }, options, deps);
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { notFoundMessage: `No such job or attempt: ${jobId}` });
      }
    });
}
