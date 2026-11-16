import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import { PROFILE_NAME_RE } from '../common/capabilities';
import { RESERVED_PROFILE_PREFIX } from '../jobs/dispatch-input';
import { AutoReviewException } from './auto-review.exception';
import { FixChecksException } from './fix-checks.exception';
import { FixUnprotectedException } from './fix-unprotected.exception';
import type { AutoReviewPatch } from './domain/fleet-repo.domain';
import { PermissionService } from '../../permissions/permission.service';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import type { IPageOption } from '@nathapp/nestjs-common';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { IPageResult } from '@nathapp/nestjs-data';
import { remapPage } from '../../common/dto/koda-page.query';
import { committedEffect, withCommittedEffects } from '../../common/committed-effects';
import { FleetActivityService } from '../activity/fleet-activity.service';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GITLAB_DEVELOPER_ACCESS, GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabRepoCredentials, type GitLabCredentialInput, type GitLabCredentialTokenInput } from '../git-broker/gitlab-repo-credentials';
import { GitTokenBroker } from '../git-broker/git-token.broker';
import { assertGitLabHostAllowed, gitlabApiBase, isClassifiableGitLabHost, parseGitLabHost } from '../git-broker/gitlab-host';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import type { RepoCheckReason } from '../git-broker/repo-check.exception';
import type { GitLabTokenKind } from '../git-broker/prisma-gitlab-credential.repository';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { FLEET_REPO_REPOSITORY, IFleetRepoRepository } from './domain/fleet-repo.domain';
import type { FleetRepoRecord } from './domain/fleet-repo.domain';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto, RuleOverrideDto } from './dto/fleet-repo.dto';
import { ruleOverrideSha256, validateRuleOverride } from './rule-override';
import { UpdateAutoReviewDto } from './dto/update-auto-review.dto';
import { UpdateFixChecksDto } from './dto/update-fix-checks.dto';
import type { UpdateFixUnprotectedDto } from './dto/update-fix-unprotected.dto';
import { assertRotationGiven, type UpdateGitlabCredentialsDto } from './dto/update-gitlab-credentials.dto';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';
import { AuditRecorder } from '../../audit/audit-recorder.service';

/**
 * What the registration check answered: the canonical identity of the repo, the host it lives on,
 * the credential to store with it and the audit summary of the write.
 */
interface VerifiedRepo {
  provider: 'github' | 'gitlab';
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: bigint | null;
  /** The host a GitLab repo lives on; absent for a GitHub repo, whose column default names it. */
  host?: string;
  /** The credential to store in the create's own transaction; absent for a GitHub repo. */
  credential?: GitLabCredentialInput;
  /** The audit summary of the registration. */
  summary: string;
}

@Injectable()
export class FleetReposService {
  constructor(
    @Inject(FLEET_REPO_REPOSITORY) private readonly repo: IFleetRepoRepository,
    private readonly github: GitHubAppClient,
    private readonly gitlab: GitLabAccessChecker,
    /** US-004: the per-repo GitLab credential store (the only reader and writer of the tokens). */
    private readonly credentials: GitLabRepoCredentials,
    /** US-005 evicts a repo's cached tokens after a rotation; US-004 only registers a repo. */
    private readonly broker: GitTokenBroker,
    /** The GitLab bot account name: a write token of that account is a bot token. */
    @Inject(FLEET_CFG) private readonly fleetConfig: Pick<IFleetConfig, 'gitlabBotName'>,
    private readonly activity: FleetActivityService,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
    private readonly audit: AuditRecorder,
    private readonly permissions: PermissionService,
  ) {}

  async create(actorId: string, dto: CreateFleetRepoDto): Promise<FleetRepoDto> {
    return (await this.prepareCreate(actorId, dto))();
  }

  async prepareCreate(actorId: string, dto: CreateFleetRepoDto): Promise<() => Promise<FleetRepoDto>> {
    const project = await this.repo.findProject(dto.projectSlug);
    if (!project) throw new NotFoundAppException({}, 'projects');

    // Forge checks run before the transaction: no DB transaction is held across HTTP.
    const verified = dto.provider === 'github'
      ? await this.verifyGitHub(dto)
      : await this.verifyGitLab(dto);

    return () => this.txManager.run(async () => {
      const current = await this.repo.findProject(dto.projectSlug);
      if (!current || current.id !== project.id) throw new NotFoundAppException({}, 'projects');
      const row = await this.repo.create({
        projectId: project.id,
        provider: dto.provider,
        owner: verified.owner,
        name: verified.name,
        defaultBranch: verified.defaultBranch,
        githubInstallationId: verified.installationId,
        ...(verified.host === undefined ? {} : { host: verified.host }),
        createdById: actorId,
      });
      // US-004: the credential row is written in the same transaction as the repo, right after it:
      // a repo without its credential is a repo whose jobs cannot read it.
      if (verified.credential !== undefined) {
        await this.credentials.save(row.id, verified.credential);
      }
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.created', entityType: 'repo', entityId: row.id,
        payload: { projectId: project.id, provider: row.provider, owner: row.owner, name: row.name },
      });
      await this.audit.record({
        key: 'fleet.repo.create', resourceType: 'fleet-repo', resourceId: row.id, projectId: row.projectId,
        summary: verified.summary,
      });
      // The answer is the stored row, so it carries the credential summary (and its warnings).
      const stored = await this.repo.findById(row.id);
      return FleetRepoDto.from(stored ?? row);
    });
  }

  /** The GitHub registration check: the App proves it can reach the repo. */
  private async verifyGitHub(dto: CreateFleetRepoDto): Promise<VerifiedRepo> {
    const verified = await this.github.verifyRepo(dto.owner, dto.name);
    return {
      provider: 'github',
      owner: verified.owner,
      name: verified.name,
      defaultBranch: verified.defaultBranch,
      installationId: verified.installationId,
      summary: 'registered github',
    };
  }

  /**
   * US-004: the GitLab registration check of a per-repo connection. The two tokens are the body's
   * own, the host is the body's own, and the checks run in a fixed order, so the first refusal is
   * the same for every caller:
   *
   * 1. the encryption key (a deployment without one costs no request at all);
   * 2. the host (canonical, a GitLab instance, and an address outside the deployment);
   * 3. the scopes of both tokens (the write token writes, the read token only reads);
   * 4. the accounts behind both tokens;
   * 5. the project, with the write token (Developer access or above);
   * 6. the project again, with the read token (it must be able to read it).
   *
   * Nothing here writes: the credential row is stored in the create's own transaction.
   */
  private async verifyGitLab(dto: CreateFleetRepoDto): Promise<VerifiedRepo> {
    // The key first: without it no token can be stored, so the request costs nothing.
    this.credentials.assertKeyConfigured();

    const host = parseGitLabHost(dto.host ?? '');
    if (!isClassifiableGitLabHost(host)) throw new RepoCheckException('gitlab_host_unclassified');
    await assertGitLabHostAllowed(host);
    const apiBase = gitlabApiBase(host);

    const writeToken = dto.writeToken;
    const readToken = dto.readToken;
    // The body of a GitLab repo carries both tokens (the DTO refuses one that does not, with a 400
    // before any request). The guard is here so a caller that skipped the pipe cannot reach the
    // forge with half a connection.
    if (writeToken === undefined || readToken === undefined) {
      throw new RepoCheckException('gitlab_scope_missing');
    }

    const connection = await this.verifyGitLabConnection(
      apiBase, `${dto.owner}/${dto.name}`, writeToken, readToken, dto.confirmBotAccount === true,
    );
    return {
      provider: 'gitlab',
      owner: connection.project.owner,
      name: connection.project.name,
      defaultBranch: connection.project.defaultBranch,
      installationId: null,
      host,
      credential: connection.credential,
      summary: connection.writeTokenIsBot
        ? 'registered gitlab'
        : `registered gitlab; write token belongs to a person (${connection.writeUsername})`,
    };
  }

  /**
   * The token, account and project checks both a registration and an initial connection setup make,
   * in the order the refusals have to mean the same thing: the scopes of both tokens (the write token
   * writes, the read token only reads), the accounts behind them, the project (found by `projectRef`
   * with the write token, Developer access or above), and the same project again with the read token.
   */
  private async verifyGitLabConnection(
    apiBase: string,
    projectRef: string,
    writeToken: string,
    readToken: string,
    confirmBotAccount: boolean,
  ) {
    const writeSelf = await this.gitlab.getTokenSelf(apiBase, writeToken);
    if (!writeSelf.scopes.includes('api') || !writeSelf.scopes.includes('write_repository')) {
      throw new RepoCheckException('gitlab_scope_missing');
    }
    const readSelf = await this.gitlab.getTokenSelf(apiBase, readToken);
    if (!readSelf.scopes.includes('read_api') || !readSelf.scopes.includes('read_repository')) {
      throw new RepoCheckException('gitlab_scope_missing');
    }
    // A read token that may also write is refused: the read path would then be a write path.
    if (readSelf.scopes.includes('api') || readSelf.scopes.includes('write_repository')) {
      throw new RepoCheckException('gitlab_read_token_writable');
    }

    const writeUser = await this.gitlab.getCurrentUser(apiBase, writeToken);
    const readUser = await this.gitlab.getCurrentUser(apiBase, readToken);

    const project = await this.gitlab.findProject(apiBase, writeToken, projectRef);
    if (project.accessLevel < GITLAB_DEVELOPER_ACCESS) throw new RepoCheckException('gitlab_access_insufficient');

    // The read token must see the very project the write token named.
    try {
      await this.gitlab.findProject(apiBase, readToken, project.id);
    } catch (error) {
      if (error instanceof RepoCheckException && error.reason === 'repo_not_found') {
        throw new RepoCheckException('gitlab_read_token_no_access');
      }
      throw error;
    }

    const writeTokenIsBot = writeUser.bot === true
      || writeUser.username === this.fleetConfig.gitlabBotName
      || confirmBotAccount;
    const credential: GitLabCredentialInput = {
      gitlabProjectId: project.id,
      read: { token: readToken, userId: readUser.id, username: readUser.username, expiresAt: readSelf.expiresAt },
      write: {
        token: writeToken, userId: writeUser.id, username: writeUser.username,
        expiresAt: writeSelf.expiresAt, isBot: writeTokenIsBot,
      },
    };
    return { project, credential, writeTokenIsBot, writeUsername: writeUser.username };
  }

  async configureAutoReview(principal: UserPrincipal | AgentPrincipal, id: string, dto: UpdateAutoReviewDto): Promise<FleetRepoDto> {
    return this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      const patch: AutoReviewPatch = dto.enabled
        ? { autoReview: true }
        : { autoReview: false, autoReviewEnabledById: null, autoReviewEnabledByType: null, autoReviewEnabledAt: null };

      if (dto.enabled) {
        if (row.provider !== 'github' || row.githubInstallationId === null) throw new AutoReviewException('github app required');
        const profiles = dto.profiles ?? [];
        if (profiles.some((profile) => !PROFILE_NAME_RE.test(profile) || profile.startsWith(RESERVED_PROFILE_PREFIX))) throw new AutoReviewException('profiles');
        if (new Set(profiles).size !== profiles.length) throw new AutoReviewException('duplicate profile');
        const caller = { type: principal.actorType === 'user' ? 'USER' as const : 'AGENT' as const, id: principal.id };
        if (!(await this.permissions.canHoldKey(caller, 'fleet.job.dispatch', { projectId: row.projectId }))) {
          throw new AutoReviewException('caller cannot dispatch in this project');
        }
        if (dto.profiles !== undefined) patch.autoReviewProfiles = [...dto.profiles];
        if (dto.maxCostUsd !== undefined) patch.autoReviewMaxCostUsd = String(dto.maxCostUsd);
        patch.autoReviewEnabledById = principal.id;
        patch.autoReviewEnabledByType = caller.type;
        patch.autoReviewEnabledAt = row.autoReview ? row.autoReviewEnabledAt : new Date();
      }

      const updated = await this.repo.updateAutoReview(id, patch);
      await this.audit.record({ key: 'fleet.repo.review.configure', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId, summary: dto.enabled ? 'enabled' : 'disabled' });
      return FleetRepoDto.from(updated);
    });
  }

  /**
   * Fleet FIX US-001: the repo-level `fixTrustDetectedChecks` switch (default off). Enabling is only
   * allowed where koda can broker a GitHub App token, because that is the flow a FIX uses to read the
   * repo and push; disabling is always allowed. The write and its audit share one transaction.
   *
   * The principal is part of the signature because the approval engine re-enters this method as the
   * requesting actor; the setting records no attribution (unlike auto-review's enabler columns), so it
   * only ever reads the switch.
   */
  async configureFixChecks(principal: UserPrincipal | AgentPrincipal, id: string, dto: UpdateFixChecksDto): Promise<FleetRepoDto> {
    return this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      if (dto.trustDetectedChecks && (row.provider !== 'github' || row.githubInstallationId === null)) {
        throw new FixChecksException('github app required');
      }
      const updated = await this.repo.updateFixChecks(id, dto.trustDetectedChecks);
      await this.audit.record({
        key: 'fleet.repo.review.configure', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId,
        summary: dto.trustDetectedChecks ? 'fix detected checks enabled' : 'fix detected checks disabled',
      });
      return FleetRepoDto.from(updated);
    });
  }

  /**
   * The FIX unprotected-branch override (default off): when on, the git token broker mints FIX write
   * credentials without checking the default branch's protection. Enabling needs a GitHub App
   * installation or stored GitLab credentials; disabling is always allowed. The write and its
   * audit share one transaction, and the principal is in the signature for the approval engine.
   */
  async configureFixUnprotected(principal: UserPrincipal | AgentPrincipal, id: string, dto: UpdateFixUnprotectedDto): Promise<FleetRepoDto> {
    return this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      if (dto.allowUnprotected) {
        if (row.provider === 'github' && row.githubInstallationId === null) {
          throw new FixUnprotectedException('github app required');
        }
        if (row.provider === 'gitlab' && row.gitlabCredential == null) {
          throw new FixUnprotectedException('gitlab credentials required');
        }
      }
      const updated = await this.repo.updateFixUnprotected(id, dto.allowUnprotected);
      await this.audit.record({
        key: 'fleet.repo.fix.unprotected', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId,
        summary: dto.allowUnprotected ? 'fix on unprotected default branch allowed' : 'fix on unprotected default branch disallowed',
      });
      return FleetRepoDto.from(updated);
    });
  }

  /**
   * US-005 (GitLab parity F1): the rotation of a repo's stored GitLab tokens — the way an admin
   * replaces a token that expired, leaked or belongs to the wrong account, because gitlab.com Free
   * offers no per-job project tokens to mint.
   *
   * Either token may be supplied, and only the supplied ones are verified and replaced: the other
   * token keeps its value, its metadata and its invalid mark, and the store clears the invalid mark
   * of the one that changed. The verification order is the registration's, because the refusals have
   * to mean the same thing:
   *
   * 1. the stored connection (a repo without one has no project to verify a token against);
   * 2. the encryption key (a deployment without one costs no request at all);
   * 3. the *stored* host (canonical, a GitLab instance, an address outside the deployment);
   * 4. each supplied token: its scopes, the account behind it, and the stored project id it must
   *    still reach — the write token with Developer access or above, the read token at all.
   *
   * Nothing here holds a transaction across HTTP: the verification runs first, and the write, its
   * audit and the re-read share one transaction afterwards. The broker cache is dropped only after
   * that transaction commits — a rotation that rolled back must not evict the tokens the cache still
   * has to answer with. Concurrent rotations are last-save-wins (out of scope): each of them evicts.
   */
  async rotateGitlabCredentials(id: string, patch: UpdateGitlabCredentialsDto): Promise<FleetRepoDto> {
    return (await this.prepareRotateGitlabCredentials(id, patch))();
  }

  /**
   * The verification half of a rotation: every forge call runs here, outside any transaction, and the
   * returned closure is the write. An approval execution calls the closure inside the transaction it
   * owns, so the forge is never called while that transaction is open.
   *
   * A repo without a credential record (every repo migrated from the single VcsConnection) is set up
   * by the same call when it carries both tokens: the project is found from the stored repo identity
   * and both tokens are verified as at registration. A repo with a record stays pinned to its stored
   * project id. There is no fallback to a VcsConnection either way.
   */
  async prepareRotateGitlabCredentials(id: string, patch: UpdateGitlabCredentialsDto): Promise<() => Promise<FleetRepoDto>> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    // A body that names no token has nothing to rotate: the same 400 the route answers before it
    // opens an approval request, so an approved request cannot be a no-op either.
    assertRotationGiven(patch);
    if (row.provider !== 'gitlab') throw new ValidationAppException({}, 'fleet.repoNotGitlab');

    const storedProjectId = row.gitlabCredential?.gitlabProjectId;
    // Without a record there is no project to verify a single token against: the initial setup needs both.
    if (storedProjectId === undefined && (patch.writeToken === undefined || patch.readToken === undefined)) {
      throw new RepoCheckException('gitlab_credentials_missing');
    }

    // The key first: without it no token can be stored, so the request costs nothing.
    this.credentials.assertKeyConfigured();
    const host = parseGitLabHost(row.host ?? '');
    if (!isClassifiableGitLabHost(host)) throw new RepoCheckException('gitlab_host_unclassified');
    await assertGitLabHostAllowed(host);
    const apiBase = gitlabApiBase(host);

    let input: GitLabCredentialInput;
    let summary: string;
    if (storedProjectId === undefined) {
      // Initial setup: the project is the one the stored repo identity names, found with the write token.
      const connection = await this.verifyGitLabConnection(
        apiBase, `${row.owner}/${row.name}`, patch.writeToken as string, patch.readToken as string,
        patch.confirmBotAccount === true,
      );
      input = connection.credential;
      summary = 'connection set up';
    } else {
      // Only the supplied kinds are part of the write: an absent token stays absent, so the store keeps
      // the token it has (and its metadata) untouched.
      input = { gitlabProjectId: storedProjectId };
      if (patch.writeToken !== undefined) {
        input.write = await this.verifyRotatedWriteToken(apiBase, patch.writeToken, storedProjectId, patch.confirmBotAccount === true);
      }
      if (patch.readToken !== undefined) {
        input.read = await this.verifyRotatedReadToken(apiBase, patch.readToken, storedProjectId);
      }
      summary = patch.readToken !== undefined && patch.writeToken !== undefined
        ? 'read and write tokens replaced'
        : patch.writeToken !== undefined ? 'write token replaced' : 'read token replaced';
    }

    return async () => {
      // The broker cache is dropped only once the transaction that owns this write has committed: an
      // eviction before the commit lets a concurrent mint read the old credential after the eviction and
      // cache it under the new generation. `evictRepo` also fences the mints in flight at that point.
      // A rotation that rolled back never evicts the tokens the cache still has to answer with.
      const updated = await withCommittedEffects(() => this.txManager.run(async () => {
        const current = await this.repo.findById(id);
        if (!current) throw new NotFoundAppException({}, 'fleet.repos');
        // The verification was made against this stored project (or its absence); a repo that was
        // re-pointed or connected in between is not the one the tokens were verified for.
        if (current.gitlabCredential?.gitlabProjectId !== storedProjectId) throw new ConflictAppException({}, 'fleet.repos');
        await this.credentials.save(id, input);
        await this.audit.record({
          key: 'fleet.repo.credentials.update', resourceType: 'fleet-repo', resourceId: id,
          projectId: row.projectId, summary,
        });
        committedEffect(() => this.broker.evictRepo(id));
        return this.repo.findById(id);
      }));
      return FleetRepoDto.from(updated ?? row);
    };
  }

  /**
   * US-005: the write half of a rotation. The token must be able to write (`api` + `write_repository`)
   * and must still reach the stored project with Developer access or above — a token for another
   * project is a mismatch, not a silent re-point of the repo.
   */
  private async verifyRotatedWriteToken(
    apiBase: string,
    token: string,
    projectId: number,
    confirmedBot: boolean,
  ): Promise<GitLabCredentialTokenInput & { isBot: boolean }> {
    const self = await this.gitlab.getTokenSelf(apiBase, token);
    if (!self.scopes.includes('api') || !self.scopes.includes('write_repository')) {
      throw new RepoCheckException('gitlab_scope_missing');
    }
    const user = await this.gitlab.getCurrentUser(apiBase, token);
    const project = await this.findRotatedProject(apiBase, token, projectId, 'gitlab_project_mismatch');
    if (project.accessLevel < GITLAB_DEVELOPER_ACCESS) throw new RepoCheckException('gitlab_access_insufficient');
    return {
      token, userId: user.id, username: user.username, expiresAt: self.expiresAt,
      isBot: user.bot === true || user.username === this.fleetConfig.gitlabBotName || confirmedBot,
    };
  }

  /**
   * US-005: the read half of a rotation. The token must read (`read_api` + `read_repository`) and must
   * not write, because the read path would then be a write path; it must also reach the stored project,
   * which is the access the read paths need.
   */
  private async verifyRotatedReadToken(
    apiBase: string,
    token: string,
    projectId: number,
  ): Promise<GitLabCredentialTokenInput> {
    const self = await this.gitlab.getTokenSelf(apiBase, token);
    if (!self.scopes.includes('read_api') || !self.scopes.includes('read_repository')) {
      throw new RepoCheckException('gitlab_scope_missing');
    }
    if (self.scopes.includes('api') || self.scopes.includes('write_repository')) {
      throw new RepoCheckException('gitlab_read_token_writable');
    }
    const user = await this.gitlab.getCurrentUser(apiBase, token);
    await this.findRotatedProject(apiBase, token, projectId, 'gitlab_read_token_no_access');
    return { token, userId: user.id, username: user.username, expiresAt: self.expiresAt };
  }

  /**
   * US-005: the stored project, seen by a token being rotated in. The caller owns the meaning of its
   * own 404 — a write token that cannot see the project is a mismatch, a read token that cannot see it
   * has no access — so only that refusal is translated.
   */
  private async findRotatedProject(
    apiBase: string,
    token: string,
    projectId: number,
    missing: Extract<RepoCheckReason, 'gitlab_project_mismatch' | 'gitlab_read_token_no_access'>,
  ): Promise<{ accessLevel: number }> {
    try {
      return await this.gitlab.findProject(apiBase, token, String(projectId));
    } catch (error) {
      if (error instanceof RepoCheckException && error.reason === 'repo_not_found') {
        throw new RepoCheckException(missing);
      }
      throw error;
    }
  }

  /**
   * US-005: the pre-gate check a rotation makes before it opens an approval request. A repo that does
   * not exist is a 404 and a repo that is not a GitLab repo is a 400 — not a request waiting for an
   * approval whose execution could only fail. The write re-checks both when it runs, so a repo
   * deleted or changed between this lookup and the execution is still refused there.
   */
  async assertRotatableGitlabRepo(id: string): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    if (row.provider !== 'gitlab') throw new ValidationAppException({}, 'fleet.repoNotGitlab');
  }

  /**
   * The repo lookup a gated rule-override write makes before it opens an approval request. A repo
   * that does not exist is a 404, not a request waiting for an approval whose execution could only
   * fail; so the gate is reached for a repo that is there.
   *
   * The write re-checks the repo inside its own transaction, so a repo deleted between this lookup
   * and the execution is still refused there.
   */
  async assertRepoExists(id: string): Promise<void> {
    if (!(await this.repo.findById(id))) throw new NotFoundAppException({}, 'fleet.repos');
  }

  /**
   * The repo's rule override (#370): the rule files and the optional project context its jobs run
   * with, in place of the ones in the repo's own checkout. The read answers the full override (the
   * rule bodies included) or null when the repo has none; an unknown repo is a 404.
   *
   * The read is not approval-gated: it hands out rule bodies, so it asks the same key the write
   * does, but a rule override is not a secret an approval has to release.
   */
  async getRuleOverride(id: string): Promise<RuleOverrideDto | null> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    const override = await this.repo.findRuleOverride(id);
    return override === null ? null : RuleOverrideDto.from(override);
  }

  /**
   * Stores the repo's rule override and audits it as a repo write. The body is validated here (the
   * route validates it before the approval gate, so an invalid body never becomes a request) and
   * the hash is computed over the validated input, so the stored row and its summary agree.
   *
   * The principal is part of the signature because the approval engine re-enters this method as the
   * requesting actor; the override records who wrote it.
   */
  async setRuleOverride(principal: UserPrincipal | AgentPrincipal, id: string, raw: unknown): Promise<FleetRepoDto> {
    return this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      const input = validateRuleOverride(raw);
      const sha256 = ruleOverrideSha256(input);
      await this.repo.upsertRuleOverride(id, input, sha256, {
        id: principal.id,
        type: principal.actorType === 'user' ? 'USER' : 'AGENT',
      });
      await this.audit.record({
        key: 'fleet.repo.rules.configure', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId,
        summary: `rule override set (${input.rules.length} files, ${input.rulesMode})`,
      });
      const updated = await this.repo.findById(id);
      return FleetRepoDto.from(updated ?? row);
    });
  }

  /**
   * Removes the repo's rule override. The audit entry is written only when there was an override to
   * remove, so a clear of a repo that never had one leaves no trace of a write that changed nothing.
   *
   * The principal is part of the signature because the approval engine re-enters this method as the
   * requesting actor; the removed row carried its own attribution, so nothing here records the
   * caller's id again.
   */
  async clearRuleOverride(principal: UserPrincipal | AgentPrincipal, id: string): Promise<FleetRepoDto> {
    return this.txManager.run(async () => {
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      if (await this.repo.deleteRuleOverride(id)) {
        await this.audit.record({
          key: 'fleet.repo.rules.configure', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId,
          summary: 'rule override cleared',
        });
      }
      const updated = await this.repo.findById(id);
      return FleetRepoDto.from(updated ?? row);
    });
  }

  /**
   * The nax flow entry's repo lookup: `remoteUrl` is turned into a provider, owner and name by the
   * caller, and the row is matched case-insensitively (a forge URL and a registered row disagree on
   * case). Null means no such repo exists for the caller to use.
   */
  findByIdentity(provider: string, owner: string, name: string): Promise<FleetRepoRecord | null> {
    return this.repo.findByIdentity(provider, owner, name);
  }

  /**
   * The repo row lock the nax entry's flow creation takes (flow lock order: repo, then flow). Must run
   * inside the caller's transaction, which is what makes the duplicate check and the insert atomic.
   */
  lockById(id: string): Promise<FleetRepoRecord | null> {
    return this.repo.lockById(id);
  }

  async findIdentity(id: string): Promise<Pick<FleetRepoRecord, 'provider' | 'owner' | 'name'> | null> {
    const row = await this.repo.findById(id);
    return row ? { provider: row.provider, owner: row.owner, name: row.name } : null;
  }

  /**
   * US-006: the projection a review event's mint needs — the repo's identity, its installation (null
   * for a repo with no GitHub App) and, since a review event can be a GitLab merge request's, the
   * forge it lives on: `provider` picks the mint path and `host` addresses its api.
   */
  async findReviewRepo(id: string): Promise<Pick<FleetRepoRecord, 'id' | 'projectId' | 'owner' | 'name' | 'githubInstallationId' | 'defaultBranch' | 'provider' | 'host'> | null> {
    const row = await this.repo.findById(id);
    if (!row) return null;
    const { projectId, owner, name, githubInstallationId, defaultBranch, provider, host } = row;
    return { id: row.id, projectId, owner, name, githubInstallationId, defaultBranch, provider, host };
  }

  async listAutoReviewRepos(limit: number): Promise<FleetRepoRecord[]> {
    return this.repo.findAutoReviewPage(limit);
  }

  /**
   * The compare-and-set turn-off (auto-review spec, call 4), with its audit in the same transaction. A pass
   * that read a stale repo list cannot turn off a repo someone else has just re-enabled: the repository only
   * changes a row still enabled by `expectedEnablerId`, and the audit is recorded only when it did.
   *
   * The project the entry names is the turned-off row's own; a row that is gone by the time the claim runs is
   * not changed at all, so no entry is written for it.
   */
  async disableAutoReview(id: string, reason: string, expectedEnablerId: string): Promise<boolean> {
    return this.txManager.run(async () => {
      if (!(await this.repo.disableAutoReviewIf(id, expectedEnablerId))) return false;
      const row = await this.repo.findById(id);
      await this.audit.record({
        key: 'system.pr-review.dispatch', resourceType: 'fleet-repo', resourceId: id,
        projectId: row?.projectId ?? null, summary: `auto-review disabled: ${reason}`,
      });
      return true;
    });
  }

  async list(filters: { projectId?: string }, page: IPageOption): Promise<IPageResult<FleetRepoDto>> {
    return remapPage(await this.repo.findPage(filters, page), FleetRepoDto.from);
  }

  /**
   * Deletion is refused while any job on the repo is unfinished (plan D15). The row
   * is locked FOR UPDATE first so the count sees a stable row (review m6).
   */
  async remove(actorId: string, id: string): Promise<void> {
    await this.txManager.run(async () => {
      await this.repo.lockForDelete(id);
      const row = await this.repo.findById(id);
      if (!row) throw new NotFoundAppException({}, 'fleet.repos');
      if ((await this.repo.countUnfinishedJobs(id)) > 0) throw new ConflictAppException({}, 'fleet.repoBusy');
      await this.repo.delete(id);
      await this.activity.record({
        actorType: 'USER', actorId, action: 'repo.deleted', entityType: 'repo', entityId: id,
        payload: { provider: row.provider, owner: row.owner, name: row.name },
      });
      await this.audit.record({ key: 'fleet.repo.delete', resourceType: 'fleet-repo', resourceId: id, projectId: row.projectId, summary: 'deleted' });
    });
  }

  /**
   * Re-runs the registration forge check (overview D119): can koda still broker git for this repo?
   * A forge verdict is returned as data; anything else is a real error and propagates.
   */
  async check(id: string, now = new Date()): Promise<RepoCheckResultDto> {
    return (await this.prepareCheck(id, now))();
  }

  async prepareCheck(id: string, now = new Date()): Promise<() => Promise<RepoCheckResultDto>> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundAppException({}, 'fleet.repos');
    const result = (reachable: boolean, reason: RepoCheckResultDto['reason']) =>
      Object.assign(new RepoCheckResultDto(), { repoId: id, reachable, reason, checkedAt: now.toISOString() });
    let checked: RepoCheckResultDto;
    // The kind of the token the forge refused, when it refused one: the closure marks it invalid.
    let invalidToken: GitLabTokenKind | null = null;
    try {
      if (row.provider === 'github') {
        if (row.githubInstallationId === null) throw new RepoCheckException('app_not_installed');
        await this.github.verifyRepo(row.owner, row.name, row.githubInstallationId);
      } else {
        await this.checkGitLab(row, (kind) => { invalidToken = kind; });
      }
      checked = result(true, null);
    } catch (error) {
      if (!(error instanceof RepoCheckException)) throw error;
      checked = result(false, error.reason);
    }
    return async () => {
      const current = await this.repo.findById(id);
      // The credential summary is left out of the comparison: a token another caller marked invalid
      // in between is not a change of the repo, so it must not turn the check into a conflict.
      if (!isDeepStrictEqual(withoutCredential(current), withoutCredential(row))) {
        throw new ConflictAppException({}, 'fleet.repos');
      }
      // The mark is written after the comparison, so a repo that changed in between is not marked.
      if (invalidToken !== null) await this.credentials.markInvalid(id, invalidToken);
      return checked;
    };
  }

  /**
   * US-004: the GitLab reachability check of a registered repo. It re-runs the token, project and
   * read-access checks of the registration against the *stored* tokens and the stored project id —
   * never the account behind a token (a check does not change who a token belongs to) and never the
   * stored metadata (a check does not rewrite the row).
   *
   * The credential is read through `resolve` and the client is called directly, so the preparation
   * writes nothing: a token the forge refuses is marked invalid by the closure, after it has
   * compared the row.
   */
  private async checkGitLab(row: FleetRepoRecord, onInvalidToken: (kind: GitLabTokenKind) => void): Promise<void> {
    const read = await this.credentials.resolve(row, 'read');
    const write = await this.credentials.resolve(row, 'write');

    const writeSelf = await this.gitlabCall('write', onInvalidToken, () => this.gitlab.getTokenSelf(write.target.apiBase, write.token));
    if (!writeSelf.scopes.includes('api') || !writeSelf.scopes.includes('write_repository')) {
      throw new RepoCheckException('gitlab_scope_missing');
    }
    const readSelf = await this.gitlabCall('read', onInvalidToken, () => this.gitlab.getTokenSelf(read.target.apiBase, read.token));
    if (!readSelf.scopes.includes('read_api') || !readSelf.scopes.includes('read_repository')) {
      throw new RepoCheckException('gitlab_scope_missing');
    }
    if (readSelf.scopes.includes('api') || readSelf.scopes.includes('write_repository')) {
      throw new RepoCheckException('gitlab_read_token_writable');
    }

    const project = await this.gitlabCall('write', onInvalidToken, () =>
      this.gitlab.findProject(write.target.apiBase, write.token, write.target.projectId));
    if (project.accessLevel < GITLAB_DEVELOPER_ACCESS) throw new RepoCheckException('gitlab_access_insufficient');

    try {
      await this.gitlabCall('read', onInvalidToken, () =>
        this.gitlab.findProject(read.target.apiBase, read.token, read.target.projectId));
    } catch (error) {
      if (error instanceof RepoCheckException && error.reason === 'repo_not_found') {
        throw new RepoCheckException('gitlab_read_token_no_access');
      }
      throw error;
    }
  }

  /**
   * One GitLab call of the check, remembering which token the forge refused. A token the instance
   * no longer knows is an invalid token — and only that refusal marks the token, so a token that
   * cannot be decrypted (a changed key) is never marked.
   */
  private async gitlabCall<T>(
    kind: GitLabTokenKind,
    onInvalidToken: (kind: GitLabTokenKind) => void,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof RepoCheckException && error.reason === 'gitlab_token_invalid') {
        onInvalidToken(kind);
      }
      throw error;
    }
  }
}

/** A repo row without its credential summary: the summary is not part of the row's identity. */
function withoutCredential(row: FleetRepoRecord | null): FleetRepoRecord | null {
  return row === null ? null : { ...row, gitlabCredential: undefined };
}
