/**
 * The deployment documentation *is* the recovery procedure: `deployments/example/README.md` carries the executable
 * steps, and `docs/deployment/postgresql.md` points at them. The integration fixture runs those steps, so it
 * catches a step that stops working — but not a shortcut added back into the prose around them, and not the
 * PostgreSQL guide drifting away.
 *
 * Kept as a unit spec (no database, no Docker) because these are the checks that have to run on every
 * `bun run test`, including the ones that cannot reach a container.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const README = resolve(__dirname, '../../../../../deployments/example/README.md');
const POSTGRES_GUIDE = resolve(__dirname, '../../../../../docs/deployment/postgresql.md');

const RESTORE_SECTION = '## Restore PostgreSQL into a fresh database';
const EXPECTED_STEP_IDS = ['1-inputs', '2-preflight', '3-replay', '4-verify', '5-cutover', '6-reversal'];

interface MarkedStep {
  id: string;
  body: string;
}

function readme(): string {
  return readFileSync(README, 'utf8');
}

function postgresGuide(): string {
  return readFileSync(POSTGRES_GUIDE, 'utf8');
}

/** The guide's executable blocks, in the order the guide prints them. */
function markedSteps(text: string): MarkedStep[] {
  const pattern = /^```bash restore-step-([0-9]+)-([a-z-]+)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  return [...text.matchAll(pattern)].map((match) => ({
    id: `${match[1] ?? ''}-${match[2] ?? ''}`,
    body: match[3] ?? '',
  }));
}

function step(steps: readonly MarkedStep[], id: string): MarkedStep {
  const found = steps.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`the guide has no restore-step-${id} block`);
  return found;
}

/** Every fenced code block of a document, whatever its language, i.e. everything an operator can copy and run. */
function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/^```[^\n]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => match[1] ?? '');
}

describe('the documented PostgreSQL recovery procedure', () => {
  it('keeps the procedure as ordered executable steps that abort on the first failure', () => {
    const steps = markedSteps(readme());

    // The integration fixture runs these blocks in this order; a missing, renamed or reordered step would
    // silently change the procedure it exercises.
    expect(steps.map((candidate) => candidate.id)).toEqual(EXPECTED_STEP_IDS);
    // errexit and pipefail are what make a nonzero step end the procedure.
    expect(step(steps, '1-inputs').body.startsWith('set -euo pipefail\n')).toBe(true);
    // ... and ON_ERROR_STOP is what makes a SQL error a nonzero step.
    expect(step(steps, '1-inputs').body).toContain('psql -X -v ON_ERROR_STOP=1 -U "$role"');
    // A decompression failure has to be caught before a database is created for the archive.
    expect(step(steps, '2-preflight').body).toContain('gzip -t "${archive}"');
    // The baseline is a gate that ends the procedure, not a report.
    expect(step(steps, '4-verify').body).toContain('if [[ "${restored_rows}" != "${baseline_rows}" ]]');
    expect(step(steps, '4-verify').body).toContain('exit 1');
  });

  it('never replays the snapshot into the database the deployment serves', () => {
    const steps = markedSteps(readme());
    const replay = step(steps, '3-replay').body;

    // Every psql call that touches the snapshot names the new database, never the live one.
    expect(replay).toContain('psql_deployment -d "${target_db}" -f -');
    expect(steps.map((candidate) => candidate.body).join('\n')).not.toContain('psql_deployment -d "${original_db}"');

    // Both documents say so, and no runnable block they show replays a dump into the live database: the
    // shortcut may only appear in prose that warns about it.
    expect(readme()).toContain(RESTORE_SECTION);
    expect(readme()).toContain('Do not replay a dump into the database the deployment is serving');
    expect(postgresGuide()).toContain('Do not replay a dump into the database the deployment is serving');

    const blocks = [...fencedBlocks(readme()), ...fencedBlocks(postgresGuide())];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/\bpsql\b[^\n]*\bkoda\b/);
      expect(block).not.toMatch(/\bpsql\b[^\n]*< ?backups\//);
    }
  });

  it('recreates the affected services for cutover and reversal, and keeps the LanceDB archive separate', () => {
    const steps = markedSteps(readme());
    const cutover = step(steps, '5-cutover').body;
    const reversal = step(steps, '6-reversal').body;

    // POSTGRES_DB is the setting the api derives DATABASE_URL from, so both directions flip that one line...
    expect(cutover).toContain('set_persistent_db "${target_db}"');
    expect(reversal).toContain('set_persistent_db "${original_db}"');
    // ... and recreate the containers: a restart does not reread the environment.
    expect(cutover).toContain('up -d --force-recreate --wait postgres api web');
    expect(reversal).toContain('up -d --force-recreate --wait postgres api web');
    for (const body of [cutover, reversal]) {
      expect(body).not.toMatch(/compose[^\n]*\brestart\b/);
    }

    // The PostgreSQL procedure and the LanceDB volume archive have separate recoveries, and the PostgreSQL
    // guide links to this one.
    expect(readme()).toContain('rollback.sh --restore-db');
    expect(readme()).toContain('koda_data-<ts>.tar.gz');
    expect(postgresGuide()).toContain('deployments/example/README.md#restore-postgresql-into-a-fresh-database');
    expect(postgresGuide()).toContain('rollback.sh --restore-db');
  });
});
