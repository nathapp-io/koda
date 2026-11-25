"""Run the checked-in fleet integration controls on a new, loopback-only PostgreSQL 16 container."""
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path


API = Path(__file__).resolve().parents[3] / "apps" / "api"
SUITES = ["project-deletion-quiesce", "fleet-schedule-ticker", "fleet-repos",
          "fleet-log-retention", "fleet-bundles", "knowledge-store"]


def docker(*args, env=None):
    return subprocess.check_output(["docker", *args], text=True, env=env).strip()


def verify_deletion_boundaries(env):
    # Reuse the real suite's boot, disk fixture and purge helpers at the reviewed revision.
    suite_dir = API / "test/integration/fleet"
    source = (suite_dir / "fleet-log-retention.integration.spec.ts").read_text()
    body, ending = source.rsplit("\n});", 1)
    assert not ending.strip()
    observation = """
  it('review observes the two repository lookups on a soft-deleted project', async () => {
    const schedules = app.get(PrismaScheduleRepository);
    const jobs = app.get(PrismaFleetJobRepository);
    const projectId = world.opsProjectId;
    const repoId = world.foreignRepoId;
    const s = await prisma.jobSchedule.create({ data: {
      projectId, repoId, name: 'lookup', cron: '0 * * * *', timezone: 'UTC',
      feature: 'lookup', ref: 'main', profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(1),
      nextFireAt: before, createdById: world.ids.root, updatedById: world.ids.root,
    } });
    const listed = async () => (await schedules.findDue(now, 50)).some(row => row.id === s.id);
    expect(await listed()).toBe(true);
    expect((await jobs.findRepo(repoId))?.projectId).toBe(projectId);
    await prisma.project.update({ where: { id: projectId }, data: { deletedAt: now } });
    expect(await listed()).toBe(false);
    expect((await jobs.findRepo(repoId))?.projectId).toBe(projectId);
    expect(await prisma.fleetJob.count({ where: { projectId } })).toBe(0);
  });

  it('review observes retention after removing a repository', async () => {
    const old = await job('review-retention', {});
    await attempt(old.id, 1);
    const files = [file('logs', old.id, '1', 'run.log'), file('jobs', old.id, '1', 'b.tar.gz')];
    const counts = () => Promise.all([
      prisma.fleetJob.count({ where: { id: old.id } }),
      prisma.fleetJobLog.count({ where: { jobId: old.id } }),
      prisma.fleetJobArtifact.count({ where: { jobId: old.id } }),
    ]);
    expect(await counts()).toEqual([1, 1, 1]);
    expect(files.every(path => existsSync(path))).toBe(true);
    await request(server).delete('/api/fleet/repos/' + world.repoId)
      .set({ Authorization: 'Bearer ' + world.tokens.root }).expect(204);
    expect(await counts()).toEqual([0, 0, 0]);
    expect(await purge(before, now)).toEqual({ expired: 0, failed: 0 });
    expect(files.every(path => existsSync(path))).toBe(true);
    console.log('05  DELETE 204; job/log/artifact rows 1/1/1 -> 0/0/0; purge expired=0; both files remain');
  });
"""
    with tempfile.NamedTemporaryFile(mode="w", dir=suite_dir, prefix="review-retention-",
                                     suffix=".integration.spec.ts") as fixture:
        fixture.write("import { PrismaScheduleRepository } from '../../../src/fleet/schedules/prisma-schedule.repository';\n"
                      "import { PrismaFleetJobRepository } from '../../../src/fleet/jobs/prisma-fleet-job.repository';\n"
                      + body + "\n" + observation + "\n});\n")
        fixture.flush()
        subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run",
                        str(Path(fixture.name).relative_to(API)), "-t", "review observes"],
                       cwd=API, env=env, check=True)
        print("04  due lookup true -> false on soft deletion; dispatch repo lookup still returns matching project")
        print("05  DELETE 204; job/log/artifact rows 1/1/1 -> 0/0/0; purge expired=0; both files remain")


def main():
    endpoint = os.environ.get("DOCKER_HOST") or json.loads(
        docker("context", "inspect", docker("context", "show")))[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise RuntimeError("This fixture needs a local Unix Docker endpoint")
    if re.search(r"(?m)^\s*(?:export\s+)?KODA_TEST_DATABASE_URL\s*=",
                 (API / ".env.test").read_text()):
        raise RuntimeError("The suite environment overrides the isolated database URL")
    secret = secrets.token_hex(24)
    container = docker("run", "-d", "--rm", "--pull=never", "--restart=no",
                       "-p", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data",
                       "-e", "POSTGRES_DB=koda_review_test", "-e", "POSTGRES_PASSWORD",
                       "postgres:16", env=dict(os.environ, POSTGRES_PASSWORD=secret))
    try:
        mapping = docker("port", container, "5432/tcp")
        port = re.fullmatch(r"127\.0\.0\.1:(\d+)", mapping).group(1)
        for _ in range(100):
            if subprocess.run(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1",
                               "-U", "postgres", "-d", "koda_review_test"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(0.3)
        else:
            raise RuntimeError("Temporary PostgreSQL did not start")
        with tempfile.TemporaryDirectory(prefix="koda-review-swc-") as cache:
            env = dict(os.environ, SWC_NATIVE_BINDING_CACHE=os.path.realpath(cache), KODA_DB_TESTS="1",
                       NAX_SANDBOXED="0", KODA_TEST_DB_CONTAINER="1",
                       KODA_TEST_DATABASE_URL=f"postgresql://postgres:{secret}@127.0.0.1:{port}/koda_review_test")
            subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run",
                            *[f"test/integration/fleet/{name}.integration.spec.ts" for name in SUITES]],
                           cwd=API, env=env, check=True)
            verify_deletion_boundaries(env)

        # Read the database's actual referential actions after Prisma installed the suite schema.
        sql = """SELECT conname, confdeltype FROM pg_constraint WHERE conname IN
                 ('FleetJob_repoId_fkey', 'FleetJobArtifact_jobId_fkey', 'FleetJobLog_jobId_fkey')
                 ORDER BY conname"""
        rows = docker("exec", container, "psql", "-U", "postgres", "-d", "koda_review_test",
                      "-At", "-c", sql).splitlines()
        assert len(rows) == 3 and all(row.endswith("|c") for row in rows), rows
        print("05  catalog reports ON DELETE CASCADE for", ", ".join(row.split("|")[0] for row in rows))
    finally:
        docker("stop", "-t", "2", container)


if __name__ == "__main__":
    main()
