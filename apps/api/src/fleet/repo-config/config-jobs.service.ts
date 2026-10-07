import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { FleetJobState } from '../../common/enums';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { FleetFenceException } from '../artifacts/bundle.exceptions';
import { isConfigKind } from '../common/config-jobs';
import type { ConfigEditMode, ConfigFileEdit } from '../common/config-jobs';
import { isAllowedNaxPath } from '../common/nax-config-paths';
import { DEFAULT_APPROVAL_TIMEOUT_SEC } from '../common/protocol';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { PlacementService } from '../jobs/placement.service';
import { DuplicateActiveJobError, FLEET_JOB_REPOSITORY, FleetJobRecord, FleetRepoRef, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { DispatchResultDto, FleetJobDto } from '../jobs/dto/fleet-job.dto';
import { FenceService } from '../sync/fence.service';
import { GIT_OBJECT_RE, validateBaseSha, validateConfigEdits, validatePrBody, validatePrTitle } from './config-edit-input';
import { CONFIG_EDIT_REPOSITORY, ConfigEditRecord, IConfigEditRepository } from './domain/config-edit.domain';
import { ConfigEditPayloadDto, RegenerateConfigDto, SubmitConfigEditDto } from './dto/config-edit.dto';
import { FLEET_REPO_FILES_READER, FleetRepoFilesReader, NaxFileContent, NaxFileList } from './fleet-repo-files.reader';
import { ConfigJobActiveException } from './repo-config.exceptions';

/** Fixed feature for config jobs: the active (repoId, feature) index then serializes them per repo (D465). */
export const CONFIG_JOB_FEATURE = 'nax-config';
const FETCH_STATES: readonly string[] = [FleetJobState.ASSIGNED, FleetJobState.RUNNING];

const toPayload = (e: ConfigEditRecord): ConfigEditPayloadDto =>
  Object.assign(new ConfigEditPayloadDto(), { mode: e.mode, edits: e.edits, prTitle: e.prTitle, prBody: e.prBody, baseSha: e.baseSha });

@Injectable()
export class ConfigJobsService {
  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly jobs: Pick<IFleetJobRepository, 'findRepo' | 'createJob' | 'appendEvent' | 'findActiveJobId' | 'findById' | 'lockById'>,
    @Inject(CONFIG_EDIT_REPOSITORY) private readonly edits: IConfigEditRepository,
    @Inject(FLEET_REPO_FILES_READER) private readonly reader: FleetRepoFilesReader,
    private readonly activity: FleetActivityService,
    private readonly live: FleetJobLivePublisher,
    private readonly placement: PlacementService,
    private readonly fence: FenceService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  async listFiles(projectId: string, repoId: string): Promise<NaxFileList> {
    return this.reader.list(await this.repoIn(projectId, repoId));
  }

  /** `ref` defaults to the default branch; otherwise it must be a commit id (the list call's baseSha). */
  async readFile(projectId: string, repoId: string, path: string, ref: string | undefined): Promise<NaxFileContent> {
    if (!isAllowedNaxPath(path)) throw new ValidationAppException({ reason: `path not allowed: ${String(path).slice(0, 200)}` }, 'fleet.configEditInput');
    if (ref !== undefined && !GIT_OBJECT_RE.test(ref)) throw new ValidationAppException({ reason: 'ref must be a commit id' }, 'fleet.configEditInput');
    const repo = await this.repoIn(projectId, repoId);
    return this.reader.read(repo, path, ref ?? repo.defaultBranch);
  }

  async submitEdit(actorId: string, projectId: string, repoId: string, body: SubmitConfigEditDto): Promise<DispatchResultDto> {
    const repo = await this.repoIn(projectId, repoId);
    const edits = validateConfigEdits(body.edits);
    const prTitle = validatePrTitle(body.prTitle);
    const prBody = validatePrBody(body.prBody);
    const baseSha = validateBaseSha(body.baseSha);
    return this.create(actorId, repo, 'edit', edits, prTitle, prBody, baseSha);
  }

  async submitRegenerate(actorId: string, projectId: string, repoId: string, body: RegenerateConfigDto): Promise<DispatchResultDto> {
    const repo = await this.repoIn(projectId, repoId);
    const prTitle = validatePrTitle(body.prTitle);
    const prBody = validatePrBody(body.prBody);
    const { baseSha } = await this.reader.list(repo);
    return this.create(actorId, repo, 'regenerate', [], prTitle, prBody, baseSha);
  }

  async submitDrift(actorId: string, projectId: string, repoId: string): Promise<DispatchResultDto> {
    const repo = await this.repoIn(projectId, repoId);
    const { baseSha } = await this.reader.list(repo);
    return this.create(actorId, repo, 'drift', [], null, null, baseSha);
  }

  /** "Reopen edits" (spec §6): the full stored edit set of a config job in this project. */
  async getEditSet(projectId: string, jobId: string): Promise<ConfigEditPayloadDto> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.projectId !== projectId || !isConfigKind(job.command)) throw new NotFoundAppException({}, 'fleet.jobs');
    const edit = await this.edits.findByJobId(jobId);
    if (!edit) throw new NotFoundAppException({}, 'fleet.jobs');
    return toPayload(edit);
  }

  /** Spec §3, D478: bundle-upload fence pattern; the runner fetches before it reports RUNNING. */
  async fetchForRunner(runnerId: string, jobId: string, leaseEpochRaw: string | undefined): Promise<ConfigEditPayloadDto> {
    const leaseEpoch = Number(leaseEpochRaw);
    if (leaseEpochRaw === undefined || !Number.isInteger(leaseEpoch) || leaseEpoch < 0) {
      throw new ValidationAppException({ reason: 'leaseEpoch' }, 'fleet.configEditInput');
    }
    const outcome = await this.txManager.run(async () => {
      const job = await this.jobs.lockById(jobId);
      if (!job || !isConfigKind(job.command)) return { kind: 'missing' as const };
      if (!this.fence.holds(job, runnerId, leaseEpoch)) {
        await this.fence.abandon(runnerId, job, leaseEpoch);
        return { kind: 'fenced' as const };
      }
      if (!FETCH_STATES.includes(job.state)) return { kind: 'state' as const, state: job.state };
      const edit = await this.edits.findByJobId(jobId);
      return edit ? { kind: 'ok' as const, edit } : { kind: 'missing' as const };
    });
    // Throw after commit so a stale lease's ABANDON is not rolled back (bundle.service.ts pattern).
    if (outcome.kind === 'missing') throw new NotFoundAppException({}, 'fleet.jobs');
    if (outcome.kind === 'fenced') throw new FleetFenceException();
    if (outcome.kind === 'state') throw new ConflictAppException({ state: outcome.state }, 'fleet.jobState');
    return toPayload(outcome.edit);
  }

  private async repoIn(projectId: string, repoId: string): Promise<FleetRepoRef> {
    const repo = await this.jobs.findRepo(repoId);
    if (!repo || repo.projectId !== projectId) throw new NotFoundAppException({}, 'fleet.repos');
    return repo;
  }

  private async create(
    actorId: string, repo: FleetRepoRef, mode: ConfigEditMode, edits: ConfigFileEdit[], prTitle: string | null, prBody: string | null, baseSha: string,
  ): Promise<DispatchResultDto> {
    const command = mode === 'drift' ? 'CONFIG_DRIFT' : 'CONFIG_EDIT';
    let job: FleetJobRecord;
    let edit: ConfigEditRecord;
    try {
      ({ job, edit } = await this.txManager.run(async () => {
        const created = await this.jobs.createJob({
          projectId: repo.projectId, repoId: repo.id, ref: repo.defaultBranch, command, feature: CONFIG_JOB_FEATURE, planFrom: null, profiles: [],
          maxCostUsd: '0', bashMode: 'raw', approvalTimeoutSec: DEFAULT_APPROVAL_TIMEOUT_SEC, selectorLabels: [], pinnedRunnerId: null, requestedById: actorId,
        });
        const row = await this.edits.create({ jobId: created.id, mode, edits, prTitle, prBody, baseSha });
        await this.jobs.appendEvent(created.id, { leaseEpoch: 0, runnerSeq: null, type: 'state', payload: { from: null, to: 'QUEUED', by: 'server', reason: null } });
        await this.activity.record({
          actorType: 'USER', actorId, action: 'job.dispatched', entityType: 'job', entityId: created.id, jobId: created.id,
          projectId: repo.projectId, responsibleUserId: actorId,
          payload: { repoId: repo.id, feature: CONFIG_JOB_FEATURE, command, ref: repo.defaultBranch, mode, files: edits.map((e) => e.path) },
        });
        return { job: created, edit: row };
      }));
    } catch (error) {
      if (!(error instanceof DuplicateActiveJobError)) throw error;
      throw new ConfigJobActiveException((await this.jobs.findActiveJobId(repo.id, CONFIG_JOB_FEATURE)) ?? 'unknown');
    }
    this.live.publish([this.live.event(job)]);
    const outcome = await this.placement.placeJob(job.id);
    const fresh = (await this.jobs.findById(job.id)) ?? job;
    return Object.assign(new DispatchResultDto(), {
      job: Object.assign(FleetJobDto.from(fresh), { tickets: [], configEdit: { mode, files: edit.edits.map((e) => e.path), prTitle: edit.prTitle, result: null } }),
      placement: { assigned: outcome.assigned, runnerId: outcome.runnerId, misfits: outcome.misfits },
    });
  }
}
