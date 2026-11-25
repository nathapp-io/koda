import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '../../generated/prisma/client';
import { Paginate, PrismaService } from '@nathapp/nestjs-prisma';
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { ACTIVE_STATES, TERMINAL_STATES } from '../jobs/job-state';
import type { RuleOverrideInput } from './rule-override';
import type {
  AutoReviewPatch,
  FleetRepoRecord,
  FleetRepoRuleOverrideRecord,
  GitLabCredentialView,
  GitLabRemoteIdentity,
  IFleetRepoRepository,
  RuleOverrideActor,
  RuleOverrideSummary,
} from './domain/fleet-repo.domain';

/**
 * The rule-override columns a repo row carries in its summary: the hash, the file count and the
 * modes. The rule bodies stay in the `rules` column and are never read for a listing.
 */
const RULE_OVERRIDE_SUMMARY_SELECT = {
  sha256: true, ruleFiles: true, rulesMode: true, contextMode: true, updatedAt: true,
} as const;

/**
 * The GitLab credential columns a repo row carries: the connection's health, never its secrets.
 * The encrypted tokens stay in the table, where only the credential store reads them.
 */
const GITLAB_CREDENTIAL_SELECT = {
  gitlabProjectId: true,
  readTokenUsername: true,
  writeTokenUsername: true,
  writeTokenIsBot: true,
  readTokenExpiresAt: true,
  writeTokenExpiresAt: true,
  readTokenInvalidAt: true,
  writeTokenInvalidAt: true,
} as const;

/**
 * The relations a repo write answers with: the rule-override summary and the GitLab connection's
 * health, never their secrets.
 *
 * A write that answered with the bare row would drop both, and the caller (the admin repos page)
 * replaces its whole row with the answer: the connected GitLab repo would look disconnected and
 * every switch the row holds would disappear until the next reload.
 */
const REPO_WRITE_INCLUDE = {
  ruleOverride: { select: RULE_OVERRIDE_SUMMARY_SELECT },
  gitlabCredential: { select: GITLAB_CREDENTIAL_SELECT },
} as const;

/**
 * The bound of a GitLab remote lookup (US-003): the read never takes more rows than this, so it never
 * scans the whole table (the API data rule). The bound applies to the rows that already carry the
 * identity the lookup asked for, so it can never hide a registered repo behind same-named rows.
 */
export const MAX_GITLAB_REMOTE_CANDIDATES = 500;

/**
 * US-009: the bound of one capture page. A repository delete copies the cleanup targets of its terminal jobs
 * in pages of this size, so a long job history is read in bounded statements and still captured completely.
 */
export const CLEANUP_CAPTURE_PAGE = 200;

/** The rule-override summary columns as a repo row carries them. */
interface RuleOverrideSummaryRow {
  sha256: string;
  ruleFiles: number;
  rulesMode: string;
  contextMode: string | null;
  updatedAt: Date;
}

/** A repo row with the rule-override summary relation, when the query asked for it. */
type FleetRepoRow = Prisma.FleetRepoGetPayload<object> & {
  ruleOverride?: RuleOverrideSummaryRow | null;
  gitlabCredential?: GitLabCredentialView | null;
};

/** The summary a stored override row answers, or null when the repo has none. */
function toSummary(row: RuleOverrideSummaryRow | null | undefined): RuleOverrideSummary | null {
  if (row === null || row === undefined) return null;
  return {
    sha256: row.sha256,
    ruleFiles: row.ruleFiles,
    rulesMode: row.rulesMode === 'replace' ? 'replace' : 'merge',
    contextMode: row.contextMode === 'replace' ? 'replace' : row.contextMode === 'append' ? 'append' : null,
    updatedAt: row.updatedAt,
  };
}

/** The rule files of a stored override, read defensively: a row koda did not write is not trusted. */
function readRules(value: Prisma.JsonValue): { path: string; content: string }[] {
  if (!Array.isArray(value)) return [];
  const rules: { path: string; content: string }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== 'string' || typeof record.content !== 'string') continue;
    rules.push({ path: record.path, content: record.content });
  }
  return rules;
}

/** The stored override of one repo, mapped to the domain record. */
function toOverrideRecord(row: {
  repoId: string;
  rules: Prisma.JsonValue;
  rulesMode: string;
  contextContent: string | null;
  contextMode: string | null;
  sha256: string;
  ruleFiles: number;
  updatedAt: Date;
}): FleetRepoRuleOverrideRecord {
  return {
    repoId: row.repoId,
    rules: readRules(row.rules),
    rulesMode: row.rulesMode === 'replace' ? 'replace' : 'merge',
    context: row.contextContent === null
      ? null
      : { content: row.contextContent, mode: row.contextMode === 'replace' ? 'replace' : 'append' },
    sha256: row.sha256,
    ruleFiles: row.ruleFiles,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaFleetRepoRepository implements IFleetRepoRepository {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  findProject(slug: string) {
    return this.db.project.findFirst({ where: { slug, deletedAt: null }, select: { id: true, slug: true } });
  }

  private toDomain(row: FleetRepoRow): FleetRepoRecord {
    return { ...row, autoReviewMaxCostUsd: row.autoReviewMaxCostUsd.toFixed(4),
      autoReviewEnabledByType: row.autoReviewEnabledByType === 'USER' || row.autoReviewEnabledByType === 'AGENT' ? row.autoReviewEnabledByType : null,
      ruleOverride: toSummary(row.ruleOverride),
      gitlabCredential: row.gitlabCredential ?? null };
  }

  async create(data: Omit<FleetRepoRecord, 'id' | 'createdAt' | 'autoReview' | 'autoReviewProfiles' | 'autoReviewMaxCostUsd' | 'autoReviewEnabledById' | 'autoReviewEnabledByType' | 'autoReviewEnabledAt' | 'fixTrustDetectedChecks' | 'fixAllowUnprotected' | 'ruleOverride' | 'gitlabCredential'>): Promise<FleetRepoRecord> {
    try {
      return this.toDomain(await this.db.fleetRepo.create({ data }));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictAppException({}, 'fleet.repos');
      }
      throw error;
    }
  }

  async updateAutoReview(id: string, patch: AutoReviewPatch): Promise<FleetRepoRecord> {
    return this.toDomain(await this.db.fleetRepo.update({ where: { id }, data: patch, include: REPO_WRITE_INCLUDE }));
  }

  /** Fleet FIX US-001: the one-column write behind `PATCH /fleet/repos/:id/fix-checks`. */
  async updateFixChecks(id: string, value: boolean): Promise<FleetRepoRecord> {
    return this.toDomain(await this.db.fleetRepo.update({ where: { id }, data: { fixTrustDetectedChecks: value }, include: REPO_WRITE_INCLUDE }));
  }

  /** The one-column write behind `PATCH /fleet/repos/:id/fix-unprotected`. */
  async updateFixUnprotected(id: string, value: boolean): Promise<FleetRepoRecord> {
    return this.toDomain(await this.db.fleetRepo.update({ where: { id }, data: { fixAllowUnprotected: value }, include: REPO_WRITE_INCLUDE }));
  }

  async findById(id: string): Promise<FleetRepoRecord | null> {
    const row = await this.db.fleetRepo.findUnique({ where: { id }, include: REPO_WRITE_INCLUDE });
    return row ? this.toDomain(row) : null;
  }

  /** The nax flow entry's remote URL: owner and name compare case-insensitively. */
  async findByIdentity(provider: string, owner: string, name: string): Promise<FleetRepoRecord | null> {
    const row = await this.db.fleetRepo.findFirst({
      where: { provider, owner: { equals: owner, mode: 'insensitive' }, name: { equals: name, mode: 'insensitive' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return row ? this.toDomain(row) : null;
  }

  /**
   * GitLab repos carrying one of the given canonical identities, in deterministic registration order.
   *
   * The identity is the row's whole identity — host, namespace and name — so the filter is the
   * lookup's answer and not a page of candidates the caller has to match afterwards: a name that
   * repeats on other hosts or namespaces cannot push the registered repo out of the bounded page.
   *
   * The comparison is literal case-insensitive equality (`LOWER(a) = LOWER(b)`) and never Prisma's
   * `mode: 'insensitive'`, which compiles to `ILIKE`: there a `_` in a namespace such as `grp_one`
   * is a wildcard that also matches `grpXone`, so the noncanonical rows it admits would consume the
   * bound and the lookup's first row could be the wrong repository.
   */
  async findGitLabByRemote(identities: readonly GitLabRemoteIdentity[]): Promise<FleetRepoRecord[]> {
    if (identities.length === 0) return [];
    const branches = identities.flatMap(({ host, owner, name }) => [
      Prisma.sql`(LOWER("host") = LOWER(${host}::text) AND LOWER("owner") = LOWER(${owner}::text) AND LOWER("name") = LOWER(${name}::text))`,
      // A stored host is canonical (no trailing slash); a row written by hand may still carry one,
      // and it names the same host.
      Prisma.sql`(LOWER("host") = LOWER(${`${host}/`}::text) AND LOWER("owner") = LOWER(${owner}::text) AND LOWER("name") = LOWER(${name}::text))`,
    ]);
    const ids = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "FleetRepo"
      WHERE "provider" = 'gitlab' AND (${Prisma.join(branches, ' OR ')})
      ORDER BY "createdAt" ASC, "id" ASC
      LIMIT ${MAX_GITLAB_REMOTE_CANDIDATES}
    `);
    if (ids.length === 0) return [];
    const rows = await this.db.fleetRepo.findMany({
      where: { id: { in: ids.map((row) => row.id) } },
      take: MAX_GITLAB_REMOTE_CANDIDATES,
    });
    // The filter's order is the answer's order (registration order, id as the tiebreak), so the
    // rows are replayed from it rather than in whatever order the hydration read returned them.
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap(({ id }) => {
      const row = byId.get(id);
      return row === undefined ? [] : [this.toDomain(row)];
    });
  }

  /** SELECT ... FOR UPDATE on the repo row (the nax flow entry's creation lock). */
  async lockById(id: string): Promise<FleetRepoRecord | null> {
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "FleetRepo" WHERE "id" = ${id} FOR UPDATE`;
    if (rows.length === 0) return null;
    return this.findById(id);
  }

  /** The project's anchor repo (S5b-R13): oldest `createdAt`, ties by smallest `id`. */
  async findAnchor(projectId: string): Promise<FleetRepoRecord | null> {
    const row = await this.db.fleetRepo.findFirst({ where: { projectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return row ? this.toDomain(row) : null;
  }

  async findAutoReviewPage(limit: number): Promise<FleetRepoRecord[]> {
    const rows = await this.db.fleetRepo.findMany({
      where: {
        autoReview: true,
        project: { deletedAt: null },
        OR: [
          { provider: 'github', githubInstallationId: { not: null } },
          { provider: 'gitlab', gitlabCredential: { isNot: null } },
        ],
      },
      orderBy: { id: 'asc' }, take: limit,
    });
    return rows.map((row) => this.toDomain(row));
  }

  async findPage(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoRecord>> {
    const where: Prisma.FleetRepoWhereInput = filters.projectId ? { projectId: filters.projectId } : {};
    const rows = await Paginate(this.db.fleetRepo, page, { where, orderBy: [{ owner: 'asc' }, { name: 'asc' }, { id: 'asc' }], include: REPO_WRITE_INCLUDE });
    return rows.remap((m) => this.toDomain(m));
  }

  /** The repo's stored rule override (#370), with its rule bodies. */
  async findRuleOverride(repoId: string): Promise<FleetRepoRuleOverrideRecord | null> {
    const row = await this.db.fleetRepoRuleOverride.findUnique({ where: { repoId } });
    return row ? toOverrideRecord(row) : null;
  }

  /** Stores the repo's rule override, replacing an earlier one. */
  async upsertRuleOverride(
    repoId: string,
    input: RuleOverrideInput,
    sha256: string,
    actor: RuleOverrideActor,
  ): Promise<FleetRepoRuleOverrideRecord> {
    const data = {
      rules: input.rules,
      rulesMode: input.rulesMode,
      contextContent: input.context?.content ?? null,
      contextMode: input.context?.mode ?? null,
      ruleFiles: input.rules.length,
      sha256,
      updatedById: actor.id,
      updatedByType: actor.type,
    };
    const row = await this.db.fleetRepoRuleOverride.upsert({
      where: { repoId },
      create: { repoId, ...data },
      update: data,
    });
    return toOverrideRecord(row);
  }

  /** Removes the repo's rule override; false when there was none. */
  async deleteRuleOverride(repoId: string): Promise<boolean> {
    const removed = await this.db.fleetRepoRuleOverride.deleteMany({ where: { repoId } });
    return removed.count > 0;
  }

  async delete(id: string): Promise<void> {
    await this.db.fleetRepo.delete({ where: { id } });
  }

  /**
   * US-009 (finding 5): the file cleanup work of the repo's terminal jobs, copied out of the rows the delete
   * cascade is about to erase. Every page is bounded (the API data rule); the id cursor makes the read both
   * complete for a repo with a long history and stable while rows are already gone.
   *
   * A job without a finish time is not captured: the retention pass decides eligibility by `finishedAt`
   * against its cutoff, so such a job has nothing to compare and the existing pass never expires it either.
   */
  async captureCleanupTargets(repoId: string): Promise<number> {
    let after: string | null = null;
    let captured = 0;
    for (;;) {
      const jobs = await this.db.fleetJob.findMany({
        where: {
          repoId,
          state: { in: [...TERMINAL_STATES] },
          finishedAt: { not: null },
          ...(after === null ? {} : { id: { gt: after } }),
        },
        orderBy: { id: 'asc' },
        take: CLEANUP_CAPTURE_PAGE,
        select: {
          id: true,
          leaseEpoch: true,
          finishedAt: true,
          artifacts: { select: { storageKey: true }, orderBy: { leaseEpoch: 'asc' } },
        },
      });
      if (jobs.length > 0) {
        // One record per job (unique jobId), so a capture that is retried in a second transaction adds
        // nothing rather than doubling the work.
        await this.db.fleetRetiredJobCleanup.createMany({
          data: jobs.map((job) => ({
            jobId: job.id,
            leaseEpoch: job.leaseEpoch,
            finishedAt: job.finishedAt as Date,
            bundleKeys: job.artifacts.map((artifact) => artifact.storageKey),
          })),
          skipDuplicates: true,
        });
        captured += jobs.length;
      }
      if (jobs.length < CLEANUP_CAPTURE_PAGE) return captured;
      after = jobs[jobs.length - 1].id;
    }
  }

  /**
   * The compare-and-set turn-off (auto-review spec, call 4). One statement, so a pass that read a stale repo
   * list cannot turn off a repo someone else has just re-enabled: the `autoReviewEnabledById` predicate fails
   * on the re-enabled row. Profiles and cost stay, so a later re-enable keeps the enabler's settings.
   */
  async disableAutoReviewIf(id: string, expectedEnablerId: string): Promise<boolean> {
    const changed = await this.db.fleetRepo.updateMany({
      where: { id, autoReview: true, autoReviewEnabledById: expectedEnablerId },
      data: { autoReview: false, autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null },
    });
    return changed.count === 1;
  }

  countUnfinishedJobs(repoId: string): Promise<number> {
    return this.db.fleetJob.count({ where: { repoId, state: { in: [...ACTIVE_STATES] } } });
  }

  async lockForDelete(id: string): Promise<void> {
    await this.db.$queryRaw`SELECT "id" FROM "FleetRepo" WHERE "id" = ${id} FOR UPDATE`;
  }
}
