"""Run #6–9 and #17 against a local, disposable PostgreSQL 16 container and the real API."""
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time

API = Path(__file__).resolve().parents[3] / "apps/api"
PROBE = """
  it('review indexes, queries and replaces actual symbol rows', async () => {
    const projectId = (await fixtureDb(app).project.findUniqueOrThrow({where:{slug:projectSlug}})).id;
    const db = fixtureDb(app).symbol;
    const repoId = 'review-index';
    const file = 'review/changed.ts';
    const other = 'review/unrelated.ts';
    const declarations = 'export function helper(){return 42;} export function main(){return helper();}';
    const index = async (commitHash: string, content: string) => body<any>(await request(httpServer)
      .post('/api/code-intel/index').set('Authorization', 'Bearer ' + adminAccessToken)
      .send({projectSlug, repoId, commitHash, files: [{path:file,content},
        {path:other,content:'export function untouched(){}'}]}).expect(201));
    const where = {projectId,repoId,file};
    const rows = () => db.findMany({where,orderBy:{name:'asc'}});
    const relation = async (name: string, direction: string) => body<any[]>(await request(httpServer)
      .get('/api/code-intel/symbols/' + encodeURIComponent(projectId+':'+repoId+':'+file+'::'+name) + '/' + direction)
      .query({projectSlug}).set('Authorization','Bearer '+adminAccessToken).expect(200));

    expect(await index('before',declarations)).toMatchObject({filesIndexed:2,symbolsIndexed:3,fileErrors:[]});
    const [helper, main] = await rows();
    expect([helper.name,main.name]).toEqual(['helper','main']);
    expect([helper.callers,main.callees]).toEqual([[],[]]);
    expect(await relation('main','callees')).toEqual([]);
    expect(await relation('helper','callers')).toEqual([]);

    // Seed only the missing edge to check the same public reads and stored IDs.
    await db.update({where:{id:main.id}, data:{callees:[helper.symbolId]}});
    await db.update({where:{id:helper.id}, data:{callers:[main.symbolId]}});
    expect((await relation('main','callees')).map(s=>s.name)).toEqual(['helper']);
    expect((await relation('helper','callers')).map(s=>s.name)).toEqual(['main']);

    const failed = await index('arrow', declarations + ' export const extra = () => 42;');
    expect(failed).toMatchObject({filesIndexed:1,symbolsIndexed:1});
    expect(failed.fileErrors).toHaveLength(1);
    expect(failed.fileErrors[0]).toMatchObject({path:file,error:expect.stringContaining('getJsDocs')});
    expect(await db.count({where})).toBe(0);
    expect(await db.count({where:{projectId,repoId,file:other,commitHash:'arrow'}})).toBe(1);
    expect(await index('repair', declarations+' export function extra(){return 42;}'))
      .toMatchObject({filesIndexed:2,symbolsIndexed:4,fileErrors:[]});
    expect(await db.count({where})).toBe(3);
    console.log('Review #6: two parsed symbols, zero edges; seeded edge retrieved in both directions.');
    console.log('Review #7: edited file rows 2 -> 0 -> 3, unaffected file retained; error returned with HTTP 201.');
  });

  it('review compares ticket representations over HTTP', async () => {
    const base = '/api/projects/' + projectSlug;
    const auth = {Authorization:'Bearer ' + adminAccessToken};
    const http = request(httpServer);
    const label = body<any>(await http.post(base+'/labels').set(auth).send({name:'contract',color:'#334455'}).expect(201));
    expect(label.projectId).toBeTruthy();
    for (const action of ['start', 'patch']) {
      const created = body<any>(await http.post(base+'/tickets').set(auth)
        .send({type:'TASK',title:'Review '+action}).expect(201));
      const url = base + '/tickets/' + created.ref;
      await http.post(url+'/labels').set(auth).send({labelId:label.id}).expect(201);
      const canonical = async () => body<any>(await http.get(url).set(auth).expect(200));
      const read = await canonical();
      expect(read.ref).toBe(created.ref);
      expect(read.labels[0].id).toBe(label.id);
      expect(read.labels[0]).not.toHaveProperty('projectId');
      const edited = body<any>(await http.patch(url).set(auth).send({title:'Edited '+action}).expect(200));
      expect(edited.ref).toBe(created.ref);
      const result = body<any>(action === 'patch'
        ? await http.patch(url).set(auth).send({status:'IN_PROGRESS'}).expect(200)
        : await http.post(url+'/start').set(auth).expect(200));
      expect(result.status).toBe('IN_PROGRESS');
      expect(result).not.toHaveProperty('ref');
      expect(result.labels[0].label.id).toBe(label.id);
      const after = await canonical();
      expect(after.status).toBe('IN_PROGRESS');
      expect(after.ref).toBe(created.ref);
      expect(after.labels[0].id).toBe(label.id);
    }
    console.log('Review #9/17: ordinary edit and GET had ref; both transitions omitted ref, nested labels; full label had projectId, ticket label omitted it.');
  });

  it('review applies a PR merge across a controlled start/snapshot ordering', async () => {
    const {VCS_REPOSITORY} = await import('../../src/vcs/domain/vcs.repository');
    const {VcsPrSyncService} = await import('../../src/vcs/vcs-pr-sync.service');
    const {withTestActor} = await import('../helpers/action-context');
    const repo = app.get(VCS_REPOSITORY);
    const sync = app.get(VcsPrSyncService);
    const db = fixtureDb(app);
    const project = await db.project.findUniqueOrThrow({where:{slug:projectSlug}});
    const connection = {provider:'github',repoOwner:'fixture',repoName:'example'};
    const candidates = () => repo.findActiveTicketLinksWithPrs(project.id,connection);
    for (const before of [true,false]) {
      const number = before ? 901 : 902;
      const url = 'https://github.com/fixture/example/pull/'+number;
      const ticket = await db.ticket.create({data:{projectId:project.id,number,type:'TASK',status:'VERIFIED',title:'Ordering control'}});
      const link = await db.ticketLink.create({data:{ticketId:ticket.id,provider:'github',linkType:'pr',prNumber:number,
        url,externalRef:'fixture/example#'+number,prState:'open'}});
      const start = () => request(httpServer).post('/api/projects/'+projectSlug+'/tickets/'+ticket.id+'/start')
        .set('Authorization','Bearer '+adminAccessToken).expect(200);
      if (before) await start();
      const snapshot = (await candidates()).find(item=>item.id===link.id);
      expect(snapshot.ticket.status).toBe(before ? 'IN_PROGRESS' : 'VERIFIED');
      if (!before) await start();
      const status = {merged:true,state:'closed',draft:false,number,url,title:'Review',mergedBy:'fixture',mergeSha:'abc'};
      const fetched = [{kind:'status',link:snapshot,status}];
      await withTestActor({type:'SYSTEM',id:'vcs'},()=>sync.applyPrStatuses(project,connection,'',fetched,'vcs.sync.pr',{isolate:true}));
      expect((await db.ticketLink.findUniqueOrThrow({where:{id:link.id}})).prState).toBe('merged');
      expect((await db.ticket.findUniqueOrThrow({where:{id:ticket.id}})).status).toBe(before ? 'VERIFY_FIX' : 'IN_PROGRESS');
      expect(await db.comment.count({where:{ticketId:ticket.id,type:'FIX_REPORT'}})).toBe(before ? 1 : 0);
      expect((await candidates()).some(item=>item.id===link.id)).toBe(false);
    }
    console.log('Review #8: early start -> VERIFY_FIX + report; late start -> IN_PROGRESS + no report. Both links merged and excluded from next poll.');
  });
"""


def docker(*args, env=None):
    return subprocess.check_output(["docker", *args], text=True, env=env).strip()


def main():
    endpoint = os.environ.get("DOCKER_HOST") or json.loads(
        docker("context", "inspect", docker("context", "show")))[0]["Endpoints"]["docker"]["Host"]
    assert endpoint.startswith("unix://"), "Use a local Docker engine"
    assert not re.search(r"(?m)^\s*(?:export\s+)?KODA_TEST_DATABASE_URL\s*=", (API / ".env.test").read_text())
    password = secrets.token_hex(20)
    container = docker("run", "--rm", "-d", "--pull=never", "--tmpfs", "/var/lib/postgresql/data",
                       "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=koda_review_test",
                       "postgres:16", env={**os.environ, "POSTGRES_PASSWORD": password})
    try:
        port = re.fullmatch(r"127\.0\.0\.1:(\d+)", docker("port", container, "5432/tcp")).group(1)
        for _ in range(100):
            if docker("exec", container, "sh", "-c", "pg_isready -h 127.0.0.1 >/dev/null && echo ready || true") == "ready":
                break
            time.sleep(.3)
        else:
            raise RuntimeError("Temporary PostgreSQL did not start")
        suite = API / "test/e2e/ast-index.e2e.spec.ts"
        source, closing = suite.read_text().rsplit("\n});", 1)
        assert not closing.strip()
        with tempfile.NamedTemporaryFile(mode="w", dir=suite.parent, prefix="review-index-", suffix=".e2e.spec.ts") as f:
            f.write(source + "\n" + PROBE + "\n});\n")
            f.flush()
            url = f"postgresql://postgres:{password}@127.0.0.1:{port}/koda_review_test"
            subprocess.run(["node", "node_modules/vitest/vitest.mjs", "run", str(Path(f.name).relative_to(API))],
                           cwd=API, env={**os.environ, "KODA_DB_TESTS":"1", "NAX_SANDBOXED":"0",
                           "KODA_TEST_DATABASE_URL":url, "DATABASE_URL":url}, check=True)
    finally:
        docker("stop", "-t", "2", container)


if __name__ == "__main__":
    main()
