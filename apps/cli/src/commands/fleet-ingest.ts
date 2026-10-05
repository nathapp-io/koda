import { Command } from 'commander';
import {
  fleetIngestControllerBackfill,
  fleetIngestControllerList,
  fleetIngestControllerRerunJob,
  fleetIngestControllerRerunOutdated,
  type IngestQueuedDto,
} from '../generated';
import { unwrap } from '../utils/api';
import { withContext } from '../utils/context';
import { handleApiError } from '../utils/error';
import { table } from '../utils/output';
import { parsePositiveInt } from '../utils/parse-positive-int';
import { oneOf } from './fleet-analytics';
import { ADMIN_TOKEN_HINT, ago, type FleetPage, handleFleetValidation, pageHint } from './fleet-shared';

const STATUSES = ['pending', 'running', 'done', 'partial', 'failed'] as const;
type IngestStatus = (typeof STATUSES)[number];

/** D386: the paged route is untyped in OpenAPI, as every koda page; this mirrors the API's IngestRowDto. */
interface IngestRow {
  id: string;
  jobId: string;
  leaseEpoch: number;
  projectId: string;
  status: IngestStatus;
  attempts: number;
  parserVersion: number;
  files: Record<string, string>;
  error: string | null;
  ingestedAt: string | null;
  updatedAt: string;
}

const ADMIN = { forbiddenHint: ADMIN_TOKEN_HINT };
const filesText = (files: Record<string, string>): string => Object.entries(files).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
const short = (text: string | null, max = 60): string => (!text ? '-' : text.length > max ? `${text.slice(0, max - 3)}...` : text);
const printQueued = (r: IngestQueuedDto): void => console.log(`Queued ${r.queued} bundle(s) for ingest`);

function registerStatus(ingest: Command): void {
  ingest
    .command('status')
    .description('Bundle ingest rows, most recently updated first (global admin)')
    .option('--status <status>', `One of ${STATUSES.join(', ')}`, oneOf(STATUSES))
    .option('--page <n>', 'Page number', parsePositiveInt, 1)
    .option('--size <n>', 'Page size (1-100)', parsePositiveInt, 20)
    .option('--json', 'Output as JSON')
    .action(async (o: { status?: IngestStatus; page: number; size: number; json?: boolean }) => {
      try {
        await withContext({}, { requireProject: false });
        const page = unwrap<FleetPage<IngestRow>>(await fleetIngestControllerList({
          query: { current: o.page, size: o.size, ...(o.status ? { status: o.status } : {}) },
        }));
        if (o.json) {
          console.log(JSON.stringify(page, null, 2));
        } else {
          table(['Job', 'Attempt', 'Project', 'Status', 'Tries', 'Files', 'Error', 'Updated'], page.records.map((r) => [
            r.jobId, String(r.leaseEpoch), r.projectId, r.status, String(r.attempts), filesText(r.files), short(r.error), ago(r.updatedAt),
          ]));
          const hint = pageHint(page);
          if (hint) console.log(hint);
        }
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, ADMIN);
      }
    });
}

function registerBackfill(ingest: Command): void {
  ingest
    .command('backfill')
    .description('Queue every stored bundle that has never been ingested (global admin)')
    .action(async () => {
      try {
        await withContext({}, { requireProject: false });
        printQueued(unwrap<IngestQueuedDto>(await fleetIngestControllerBackfill()));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, ADMIN);
      }
    });
}

function registerRerun(ingest: Command): void {
  ingest
    .command('rerun [jobId]')
    .description("Re-ingest one job's bundles, or with --all every bundle parsed by an older parser (global admin)")
    .option('--all', 'Re-ingest bundles ingested by an older parser version')
    .action(async (jobId: string | undefined, o: { all?: boolean }) => {
      if (Boolean(jobId) === Boolean(o.all)) return handleFleetValidation('Give a job id or --all, not both');
      try {
        await withContext({}, { requireProject: false });
        const result = jobId
          ? await fleetIngestControllerRerunJob({ path: { jobId } })
          : await fleetIngestControllerRerunOutdated();
        printQueued(unwrap<IngestQueuedDto>(result));
        process.exit(0);
      } catch (err: unknown) {
        handleApiError(err, { ...ADMIN, notFoundMessage: `Job not found: ${jobId}` });
      }
    });
}

/** `koda fleet ingest …` (spec §4.4, D370). */
export function registerFleetIngest(fleet: Command): void {
  const ingest = fleet.command('ingest');
  ingest.description('Bundle ingest health and re-runs (global admin)');
  registerStatus(ingest);
  registerBackfill(ingest);
  registerRerun(ingest);
}
