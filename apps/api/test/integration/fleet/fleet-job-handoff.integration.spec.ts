import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-006 (#477): the chat run's record is stored with the job that takes it over — a handoff RUN —
 * and with nothing else. Only a flow dispatches a handoff RUN, so the record never reaches a
 * public job route.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-job-handoff.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import type { HandoffRecordFile } from '@nathapp/fleet-protocol';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FleetJobsService } from '../../../src/fleet/jobs/fleet-jobs.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const RECORD: HandoffRecordFile[] = [
  { runId: 'run-1', file: 'result.json', mtimeMs: 1_700_000_000_000, content: '{"schemaVersion":1}' },
  { runId: 'run-1', file: 'ledger.md', mtimeMs: 1_700_000_000_000, content: '# ledger' },
];

describeIntegration('a dispatched job stores the handoff record (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let jobs: FleetJobsService;
  let projectId: string;
  let repoId: string;
  let actorId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    ({ projectId, repoId, adminId: actorId } = await seedFleetBase(db));
    jobs = app.get(FleetJobsService);
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  it('AC-12: a REVIEW dispatch stores no handoff record', async () => {
    const result = await withTestActor({ type: 'USER', id: actorId }, async () => jobs.dispatch(actorId, projectId, {
      repoId, command: 'REVIEW', prNumber: 12, maxCostUsd: 5,
    }, { handoff: RECORD }));

    const stored = await db.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } });
    expect(stored.handoff).toBeNull();
  });

  it('a RUN dispatch stores the handoff record it was given', async () => {
    const result = await withTestActor({ type: 'USER', id: actorId }, async () => jobs.dispatch(actorId, projectId, {
      repoId, command: 'RUN', feature: 'handoff-run', maxCostUsd: 5,
    }, { handoff: RECORD }));

    const stored = await db.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } });
    expect(stored.handoff).toEqual(RECORD);
  });

  it('the stored record keeps the chat run\'s bytes, multi-byte text included', async () => {
    // The record holds the chat run's own files: the JSONB column stores their text as it is, so
    // the runner restores exactly what the chain produced.
    const record: HandoffRecordFile[] = [
      { runId: 'run-1', file: 'result.json', mtimeMs: 1_700_000_000_000, content: '{"schemaVersion":1,"note":"shipped 🚀"}' },
      { runId: 'run-1', file: 'ledger.md', mtimeMs: 1_700_000_000_000, content: '# ledger\n"quoted" \\ backslash\n' },
    ];
    const result = await withTestActor({ type: 'USER', id: actorId }, async () => jobs.dispatch(actorId, projectId, {
      repoId, command: 'RUN', feature: 'handoff-run-bytes', maxCostUsd: 5,
    }, { handoff: record }));

    const stored = await db.fleetJob.findUniqueOrThrow({ where: { id: result.job.id } });
    expect(stored.handoff).toEqual(record);
  });
});
