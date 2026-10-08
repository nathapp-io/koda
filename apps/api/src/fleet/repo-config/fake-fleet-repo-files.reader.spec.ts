import { FakeFleetRepoFilesReader } from './fake-fleet-repo-files.reader';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';

const repo: FleetRepoRef = { id: 'r1', projectId: 'p', provider: 'github', owner: 'acme', name: 'e2e-app', defaultBranch: 'main', githubInstallationId: null };

describe('FakeFleetRepoFilesReader (E2E only)', () => {
  it('serves seeded allowlisted files with git blob SHAs, sorted by path', async () => {
    const fake = new FakeFleetRepoFilesReader();
    const { headSha } = fake.seed('r1', { '.nax/rules/b.md': 'b', '.nax/context.md': 'hello\n', '.nax/profiles/x.env': 'SECRET=1', 'README.md': 'x' });
    const list = await fake.list(repo);
    expect(list.baseSha).toBe(headSha);
    expect(list.defaultBranch).toBe('main');
    expect(list.files.map((f) => [f.path, f.group])).toEqual([['.nax/context.md', 'context'], ['.nax/rules/b.md', 'rules']]);
    // `git hash-object` of "hello\n"
    expect(list.files[0].blobSha).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await fake.read(repo, '.nax/context.md', headSha)).toEqual({ path: '.nax/context.md', blobSha: 'ce013625030ba8dba906f756967f9e9ca394464a', content: 'hello\n' });
  });

  it('re-seeding changes the head and the blob SHA of a changed file; an unseeded repo is empty', async () => {
    const fake = new FakeFleetRepoFilesReader();
    const first = fake.seed('r1', { '.nax/context.md': 'a' });
    const second = fake.seed('r1', { '.nax/context.md': 'b' });
    expect(second.headSha).not.toBe(first.headSha);
    expect((await fake.list({ ...repo, id: 'other' })).files).toEqual([]);
  });

  it('reading a missing path is a not-found error', async () => {
    const fake = new FakeFleetRepoFilesReader();
    fake.seed('r1', {});
    await expect(fake.read(repo, '.nax/context.md', 'x')).rejects.toThrow();
  });
});
