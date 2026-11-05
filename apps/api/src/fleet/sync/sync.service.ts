import { Inject, Injectable, Logger } from '@nestjs/common';
import { bookkeeping } from '../../action-context/audit-coverage';
import { AuthException } from '@nathapp/nestjs-common';
import { FleetJobKind } from '../../common/enums';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import type { LiveFleetJobEvent } from '../../live/live-event';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { parseCapabilities } from '../common/capabilities';
import { isSupportedProtocolVersion } from '../common/protocol';
import type {
  FleetCommandOut, GitToken, GitTokenError, JobAck, ProviderKeyError, ProviderKeyGrant, ProviderKeyRequest, SyncResponse,
} from '../common/protocol';
import { responsibleUserOf } from '../common/responsible-user';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { FleetJobLivePublisher } from '../jobs/fleet-job-live.publisher';
import { PlacementService } from '../jobs/placement.service';
import { RunnerNotifier } from '../jobs/runner-notifier';
import { fetchableProjectRepos } from '../jobs/project-repos-assign';
import type { FleetJobRecord, FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FLEET_JOB_REPOSITORY, IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import { RUNNER_HELD_STATES, isTerminal } from '../jobs/job-state';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service';
import type { ProviderCredential } from '../provider-credentials/provider-credential.domain';
import { FleetJobTicketEffects } from '../tickets/fleet-job-ticket.effects';
import { ProtocolVersionException } from '../runners/protocol-version.exception';
import { FenceService } from './fence.service';
import { CommandAckProcessor } from './command-ack.processor';
import { JobReportProcessor } from './job-report.processor';
import { PrAttributionService } from './pr-attribution.service';
import { parseSyncRequest } from './sync-request.parser';
import { ThreadJobEffects } from '../threads/thread-job-effects';
import { CHAT_THREAD_REPOSITORY, type ChatThreadRepository } from '../threads/domain/chat-thread.domain';

/** US-006: the hand-out lease a provider key grant carries. */
export const PROVIDER_KEY_LEASE_MS = 10 * 60_000;

/** US-006: what one sync's provider requests produced, merged into the sync response. */
interface ProviderGrantOutcome {
  providerKeys: ProviderKeyGrant[];
  providerKeyErrors: ProviderKeyError[];
  unknownJobIds: string[];
}

/**
 * POST /fleet/runner/sync (spec §3.2). Step 1 is several short transactions (plan D5):
 * acks, one per reported job, boot reconcile, placement fill. Step 2, only when there is
 * nothing to return: wait for a command, holding no transaction or connection.
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @Inject(FLEET_JOB_REPOSITORY) private readonly repo: IFleetJobRepository,
    private readonly reports: JobReportProcessor,
    private readonly acks: CommandAckProcessor,
    private readonly placement: PlacementService,
    private readonly live: FleetJobLivePublisher,
    private readonly notifier: RunnerNotifier,
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'syncWaitMs'>,
    private readonly broker: GitTokenBroker,
    private readonly fence: FenceService,
    private readonly attribution: PrAttributionService,
    private readonly ticketEffects: FleetJobTicketEffects,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly threadEffects: ThreadJobEffects,
    @Inject(CHAT_THREAD_REPOSITORY) private readonly threads: ChatThreadRepository,
    private readonly providerCredentials: ProviderCredentialsService,
    private readonly activity: FleetActivityService,
  ) {}

  async sync(runnerId: string, raw: unknown): Promise<SyncResponse> {
    const version = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).protocolVersion : undefined;
    if (!isSupportedProtocolVersion(version)) throw new ProtocolVersionException(version);
    const req = parseSyncRequest(raw);
    const capabilities = req.capabilities === undefined ? undefined : parseCapabilities(req.capabilities);
    const now = new Date();
    const seen = await bookkeeping('runner.heartbeat', () => this.repo.recordRunnerSync(runnerId, {
      now, bootId: req.bootId, daemonVersion: req.daemonVersion, protocolVersion: req.protocolVersion, capabilities,
    }));
    if (!seen) throw new AuthException({}, 'fleet.runnerAuth');

    const { live: ackLive } = await this.acks.process(runnerId, req.bootId, req.commandAcks, now);
    const live: LiveFleetJobEvent[] = [...ackLive];
    const jobAcks: JobAck[] = [];
    const unknownJobIds: string[] = [];
    for (const report of req.jobs) {
      // One failing job must not block the rest of the sync (review M2): no ack for it, the runner resends it.
      try {
        const outcome = await this.reports.process(runnerId, report, now);
        if (outcome.ack) jobAcks.push(outcome.ack);
        if (outcome.unknown) unknownJobIds.push(report.jobId);
        live.push(...outcome.live);
      } catch (error) {
        this.logger.error(`Sync: job ${report.jobId} from runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    // Every sync, not only when the boot id changed (review M3): a crash between recording the new
    // boot id and queueing READOPT must not strand held jobs. Idempotent through runnerBootId and
    // the pending-READOPT check.
    try {
      await this.acks.reconcileBoot(runnerId, req.bootId, now, seen.previousBootId !== req.bootId);
    } catch (error) {
      this.logger.error(`Sync: boot reconcile for runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    this.live.publish(live);
    if (req.freeSlots > 0) {
      try {
        await this.placement.fillRunner(runnerId, req.freeSlots, now);
      } catch (error) {
        this.logger.error(`Sync: placement for runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    if (req.protocolVersion >= 4) {
      try {
        await this.placement.fillRunnerThreads(runnerId, now);
      } catch (error) {
        this.logger.error(`Sync: placement for runner ${runnerId} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    await this.afterTerminal(live.filter((e) => isTerminal(e.state)).map((e) => e.jobId));

    const tokens = await this.grantTokens(runnerId, req.tokenRequests, now);
    const provider = await this.grantProviderKeys(runnerId, req.providerRequests ?? [], now);
    let commands = await this.deliver(runnerId, now);
    const idle = jobAcks.length === 0 && unknownJobIds.length === 0 && commands.length === 0 &&
      tokens.gitTokens.length === 0 && tokens.gitTokenErrors.length === 0 && tokens.unknownJobIds.length === 0 &&
      // US-006: a grant or a refusal is an answer, so the runner must not wait out the long poll for it.
      provider.providerKeys.length === 0 && provider.providerKeyErrors.length === 0 && provider.unknownJobIds.length === 0;
    if (idle) {
      await this.notifier.wait(runnerId, this.fleetConfig.syncWaitMs, async () => (await this.repo.findPendingCommands(runnerId)).length > 0);
      commands = await this.deliver(runnerId, new Date());
    }
    return {
      jobAcks, commands, gitTokens: tokens.gitTokens, gitTokenErrors: tokens.gitTokenErrors,
      providerKeys: provider.providerKeys, providerKeyErrors: provider.providerKeyErrors,
      unknownJobIds: [...new Set([...unknownJobIds, ...tokens.unknownJobIds, ...provider.unknownJobIds])],
      archivedThreadIds: await this.threads.archivedThreadIds(runnerId),
    };
  }

  /** Spec §6.3: fence each request (ABANDON on a stale epoch), then mint outside any transaction. */
  protected async grantTokens(runnerId: string, requests: ReadonlyArray<{ jobId: string; leaseEpoch: number; repoId?: string; fresh?: true }>, now: Date) {
    const gitTokens: GitToken[] = [];
    const gitTokenErrors: GitTokenError[] = [];
    const unknownJobIds: string[] = [];
    const toMint = await this.txManager.run(async () => {
      const granted: Array<{ jobId: string; leaseEpoch: number; repo: FleetRepoRef; readOnly?: boolean; purpose?: 'review' | 'fix' }> = [];
      for (const req of requests) {
        // Row lock: two overlapping syncs from one runner must not both queue an ABANDON.
        const job = await this.repo.lockById(req.jobId);
        if (!job) {
          unknownJobIds.push(req.jobId);
        } else if (!this.fence.holds(job, runnerId, req.leaseEpoch)) {
          await this.fence.abandon(runnerId, job, req.leaseEpoch);
        } else if (!(RUNNER_HELD_STATES as readonly string[]).includes(job.state)) {
          gitTokenErrors.push({ jobId: job.id, reason: 'job_not_active', ...(req.repoId !== undefined ? { repoId: req.repoId } : {}) });
        } else if (req.repoId !== undefined) {
          // No stored ASSIGN scope: recompute with the same ordered, capped walk used by placement.
          const scope = job.command === 'THREAD' ? await this.repo.findThreadTokenScope(job.id) : null;
          const repos = scope?.kind === 'PROJECT' && scope.action === 'SESSION'
            ? fetchableProjectRepos(await this.repo.findProjectRepos(job.projectId)) : [];
          const repo = repos.find((r) => r.id === req.repoId);
          if (repo) granted.push({ jobId: job.id, leaseEpoch: job.leaseEpoch, repo, readOnly: true });
          else gitTokenErrors.push({ jobId: job.id, repoId: req.repoId, reason: 'repo_not_assigned' });
        } else if (job.command === 'THREAD' && ['WORKSPACE', 'PROJECT'].includes((await this.repo.findThreadTokenScope(job.id))?.kind ?? '')) {
          gitTokenErrors.push({ jobId: job.id, reason: 'repo_not_assigned' });
        } else {
          const repo = await this.repo.findRepo(job.repoId);
          if (repo) granted.push({
            jobId: job.id,
            leaseEpoch: job.leaseEpoch,
            repo,
            ...(job.command === FleetJobKind.REVIEW ? { purpose: 'review' as const } : job.command === FleetJobKind.FIX ? { purpose: 'fix' as const } : {}),
            ...(req.fresh === true && (job.command === FleetJobKind.FIX || job.command === FleetJobKind.REVIEW) ? { fresh: true } : {}),
          });
        }
      }
      return granted;
    });
    for (const req of toMint) {
      const result = await this.broker.mint(req, now);
      // strictNullChecks is off repo-wide, so `result.ok` does not narrow the MintResult union; `in` does.
      if ('error' in result) gitTokenErrors.push(result.error);
      else gitTokens.push(result.token);
    }
    return { gitTokens, gitTokenErrors, unknownJobIds };
  }

  /**
   * US-006: hand out provider keys. Each request is fenced like a token request (row lock first, so two
   * overlapping syncs queue one ABANDON), then checked for a runner-held state, for an enabled vault,
   * and for the job's scope — a THREAD job's own thread, a fleet job's project/repo. Nothing is
   * decrypted before those checks pass, and the issue row and its `credential.issued` activity commit in
   * the same transaction, so the attribution and the hand-out cannot disagree.
   */
  protected async grantProviderKeys(
    runnerId: string,
    requests: readonly ProviderKeyRequest[],
    now: Date,
  ): Promise<ProviderGrantOutcome> {
    const providerKeys: ProviderKeyGrant[] = [];
    const providerKeyErrors: ProviderKeyError[] = [];
    const unknownJobIds: string[] = [];
    if (requests.length === 0) return { providerKeys, providerKeyErrors, unknownJobIds };
    await this.txManager.run(async () => {
      for (const req of requests) {
        const job = await this.repo.lockById(req.jobId);
        if (!job) {
          unknownJobIds.push(req.jobId);
          continue;
        }
        if (!this.fence.holds(job, runnerId, req.leaseEpoch)) {
          await this.fence.abandon(runnerId, job, req.leaseEpoch);
          continue;
        }
        const refusal = this.providerRefusalOf(job);
        if (refusal !== null) {
          providerKeyErrors.push({ jobId: job.id, providerId: req.providerId, reason: refusal });
          continue;
        }
        const scope = await this.credentialScopeOf(job);
        // A thread job whose turn is gone has no scope to resolve in: answer none rather than guess one.
        const credential = scope
          ? await this.providerCredentials.resolve({ projectId: scope.projectId, repoId: scope.repoId, providerId: req.providerId })
          : null;
        const key = credential === null ? null : this.providerCredentials.issueKey(credential);
        if (credential === null || key === null) {
          providerKeyErrors.push({ jobId: job.id, providerId: req.providerId, reason: 'none' });
          continue;
        }
        providerKeys.push({
          jobId: job.id,
          providerId: credential.providerId,
          key,
          expiresAt: new Date(now.getTime() + PROVIDER_KEY_LEASE_MS).toISOString(),
          account: `koda:${credential.scope.toLowerCase()}:${credential.name}`,
          fingerprint: credential.fingerprint,
        });
        await this.recordIssue(runnerId, job, credential);
      }
    });
    return { providerKeys, providerKeyErrors, unknownJobIds };
  }

  /** Why this job may not be handed a key, or null when it may. State and vault first: they leak nothing. */
  private providerRefusalOf(job: FleetJobRecord): ProviderKeyError['reason'] | null {
    if (!(RUNNER_HELD_STATES as readonly string[]).includes(job.state)) return 'job_not_active';
    if (!this.providerCredentials.isEnabled()) return 'vault_off';
    return null;
  }

  /**
   * The scope a job's key is resolved in. A fleet job answers from its own row; a THREAD job answers from
   * the thread's own project and repo, because its `repoId` is only the worktree anchor (a PROJECT thread
   * must not borrow the REPO key of the repo it happens to be anchored on).
   */
  private async credentialScopeOf(job: FleetJobRecord): Promise<{ projectId: string; repoId: string | null } | null> {
    if (job.command !== FleetJobKind.THREAD) return { projectId: job.projectId, repoId: job.repoId };
    return this.repo.findThreadCredentialScope(job.id);
  }

  /**
   * One hand-out, deduplicated on (job, credential, fingerprint): only the first issue of a key to a job
   * records `credential.issued`, so a runner that re-requests within the lease adds no feed noise. Both
   * rows are bookkeeping of the hand-out itself — the sync records no domain audit entry.
   */
  private recordIssue(runnerId: string, job: FleetJobRecord, credential: ProviderCredential): Promise<void> {
    return bookkeeping('runner.provider-key-issue', async () => {
      const issued = await this.providerCredentials.recordIssue({
        jobId: job.id, credentialId: credential.id, fingerprint: credential.fingerprint,
      });
      if (!issued) return;
      await this.activity.record({
        actorType: 'RUNNER', actorId: runnerId, action: 'credential.issued',
        entityType: 'provider_credential', entityId: credential.id, jobId: job.id, projectId: job.projectId,
        responsibleUserId: responsibleUserOf(job),
        payload: { providerId: credential.providerId, scope: credential.scope, name: credential.name, fingerprint: credential.fingerprint },
      });
    });
  }

  /** Evicts cached tokens; posts the attribution comment (spec §7.1); ticket effects (C9 §3.2). */
  protected async afterTerminal(jobIds: readonly string[]): Promise<void> {
    const ids = [...new Set(jobIds)];
    for (const id of ids) {
      this.broker.evict(id);
      void this.attribution.attribute(id); // fire-and-forget; never throws
    }
    if (ids.length > 0) void this.ticketEffects.onTerminal(ids); // fire-and-forget; never throws (D451)
  }

  private async deliver(runnerId: string, now: Date): Promise<FleetCommandOut[]> {
    const pending = await this.repo.findPendingCommands(runnerId);
    await bookkeeping('runner.command-delivery', () => this.repo.markDelivered(pending.filter((c) => c.deliveredAt === null).map((c) => c.id), now));
    return pending.map((c) => ({ commandId: c.id, type: c.type, jobId: c.jobId, leaseEpoch: c.leaseEpoch, payload: c.payload as FleetCommandOut['payload'] }));
  }
}
