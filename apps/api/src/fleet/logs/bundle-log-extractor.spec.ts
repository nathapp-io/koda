import { Readable } from 'stream';
import { tarGz } from '../../../test/helpers/tar-gz';
import { extractBundleMembers, listBundleMembers, pickLogMembers } from './bundle-log-extractor';

const job = { command: 'RUN', feature: 'feat-a', naxLogRunId: null as string | null };
const runs = 'nax-out/features/feat-a/runs';

describe('bundle log extraction', () => {
  it('lists file members only, with ./ stripped', async () => {
    const gz = await tarGz([
      { name: './nax.stdout', body: 'out' },
      { name: `${runs}/r1.jsonl`, body: '{}\n' },
      { name: `${runs}/latest.jsonl`, type: 'symlink', linkname: 'r1.jsonl' },
    ]);
    const members = await listBundleMembers(Readable.from([gz]));
    expect(members.map((m) => m.name).sort()).toEqual(['nax-out/features/feat-a/runs/r1.jsonl', 'nax.stdout']);
  });

  it('picks the run log by naxLogRunId, else the single file, else the newest; never latest or another feature', async () => {
    const m = (name: string, mtimeMs = 0) => ({ name, size: 1, mtimeMs });
    const base = [m('nax.stdout'), m('nax.stderr'), m(`${runs}/a.jsonl`, 1000), m(`${runs}/b.jsonl`, 2000), m('nax-out/features/other/runs/z.jsonl', 9000)];
    expect(pickLogMembers(base, { ...job, naxLogRunId: 'a' }).run?.name).toBe(`${runs}/a.jsonl`);
    expect(pickLogMembers(base, job).run?.name).toBe(`${runs}/b.jsonl`);
    expect(pickLogMembers([m(`${runs}/only.jsonl`)], job).run?.name).toBe(`${runs}/only.jsonl`);
    expect(pickLogMembers([m(`${runs}/latest.jsonl`)], job).run).toBeUndefined();
    expect(pickLogMembers([m('nax-out/features/other/runs/z.jsonl')], job).run).toBeUndefined(); // Review Focus 4
    expect(pickLogMembers([m(`${runs}/nested/x.jsonl`)], job).run).toBeUndefined();
    expect(pickLogMembers(base, { ...job, command: 'PLAN' }).run).toBeUndefined();
    expect(pickLogMembers(base, job).stdout?.name).toBe('nax.stdout');
    expect(pickLogMembers(base, job).stderr?.name).toBe('nax.stderr');
  });

  it('streams only the wanted members to the sink and drains the rest', async () => {
    const gz = await tarGz([{ name: 'nax.stdout', body: 'OUT' }, { name: 'skip.bin', body: 'xxxx' }, { name: 'nax.stderr', body: 'ERR' }]);
    const got: Record<string, string> = {};
    await extractBundleMembers(Readable.from([gz]), new Map([['nax.stdout', 'stdout'], ['nax.stderr', 'stderr']]), async (stream, entry) => {
      const chunks: Buffer[] = [];
      for await (const c of entry) chunks.push(c as Buffer);
      got[stream] = Buffer.concat(chunks).toString();
    });
    expect(got).toEqual({ stdout: 'OUT', stderr: 'ERR' });
  });

  it('rejects a corrupt gzip', async () => {
    await expect(listBundleMembers(Readable.from([Buffer.from('not gzip')]))).rejects.toThrow();
  });
});
