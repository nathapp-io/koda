import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { isAllowedNaxPath, naxPathGroup, type NaxPathGroup } from '../common/nax-config-paths';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import type { FleetRepoFilesReader, NaxFileContent, NaxFileList } from './fleet-repo-files.reader';

/** The SHA `git hash-object` prints, so the runner-side staleness check would agree with it. */
const gitBlobSha = (content: string): string => {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

interface FakeRepoState { headSha: string; files: ReadonlyMap<string, string> }

const EMPTY: FakeRepoState = { headSha: '0'.repeat(40), files: new Map() };

/**
 * TEST ONLY (S3 plan Task C11): an in-memory FleetRepoFilesReader for the web E2E stack, which has no forge. Bound only
 * when FLEET_TEST_HOOKS and FLEET_TEST_FAKE_NAX_FILES are both true outside production. Ignores `ref`.
 */
@Injectable()
export class FakeFleetRepoFilesReader implements FleetRepoFilesReader {
  private repos: ReadonlyMap<string, FakeRepoState> = new Map();

  seed(repoId: string, files: Readonly<Record<string, string>>): { headSha: string } {
    const allowed = Object.entries(files).filter(([path]) => isAllowedNaxPath(path));
    const headSha = createHash('sha1')
      .update(allowed.map(([path, content]) => `${path}:${gitBlobSha(content)}`).sort().join('\n'))
      .digest('hex');
    this.repos = new Map([...this.repos, [repoId, { headSha, files: new Map(allowed) }]]);
    return { headSha };
  }

  async list(repo: FleetRepoRef): Promise<NaxFileList> {
    const state = this.repos.get(repo.id) ?? EMPTY;
    const files = [...state.files]
      .map(([path, content]) => ({ path, size: Buffer.byteLength(content, 'utf8'), blobSha: gitBlobSha(content), group: naxPathGroup(path) as NaxPathGroup }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return { baseSha: state.headSha, defaultBranch: repo.defaultBranch, files };
  }

  async read(repo: FleetRepoRef, path: string, _ref: string): Promise<NaxFileContent> {
    const content = (this.repos.get(repo.id) ?? EMPTY).files.get(path);
    if (content === undefined) throw new NotFoundAppException({}, 'fleet.repos');
    return { path, blobSha: gitBlobSha(content), content };
  }
}
