import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { gitlabTokenStatus } from '../../git-broker/gitlab-repo-credentials';
import type { FleetRepoRecord, FleetRepoRuleOverrideRecord, GitLabCredentialView } from '../domain/fleet-repo.domain';

/** One rule file of a repo's override: its path under the rules directory and its body. */
export class RuleOverrideFileDto {
  @ApiProperty({ description: 'Rule file path, relative to the job rules directory' })
  declare path: string;
  @ApiProperty({ description: 'The rule file body' })
  declare content: string;
}

/** The project context a repo's override adds to (or replaces) the project's own. */
export class RuleOverrideContextDto {
  @ApiProperty({ description: 'The context body' })
  declare content: string;
  @ApiProperty({ enum: ['append', 'replace'], description: 'Whether the context is appended to the project context or replaces it' })
  declare mode: 'append' | 'replace';
}

/**
 * The override's facts without its bodies: what a repo listing carries, so listing repos never
 * loads the rule files.
 */
export class RuleOverrideSummaryDto {
  @ApiProperty({ description: 'SHA-256 of the validated override' })
  declare sha256: string;
  @ApiProperty({ description: 'How many rule files the override carries' })
  declare ruleFiles: number;
  @ApiProperty({ enum: ['merge', 'replace'], description: 'Whether the rules merge with the repo rules or replace them' })
  declare rulesMode: 'merge' | 'replace';
  @ApiPropertyOptional({ enum: ['append', 'replace'], nullable: true, description: 'Whether the context is appended to the project context or replaces it' })
  declare contextMode: 'append' | 'replace' | null;
  @ApiProperty({ description: 'When the override was last written (ISO 8601)' })
  declare updatedAt: string;
}

/** The full override of one repo: its rule bodies, its modes and its hash. */
export class RuleOverrideDto {
  @ApiProperty({ type: () => RuleOverrideFileDto, isArray: true })
  declare rules: RuleOverrideFileDto[];
  @ApiProperty({ enum: ['merge', 'replace'] })
  declare rulesMode: 'merge' | 'replace';
  @ApiPropertyOptional({ type: () => RuleOverrideContextDto, nullable: true })
  declare context: RuleOverrideContextDto | null;
  @ApiProperty({ description: 'SHA-256 of the validated override' })
  declare sha256: string;
  @ApiProperty({ description: 'When the override was last written (ISO 8601)' })
  declare updatedAt: string;

  static from(record: FleetRepoRuleOverrideRecord): RuleOverrideDto {
    return Object.assign(new RuleOverrideDto(), {
      rules: record.rules.map((rule) => Object.assign(new RuleOverrideFileDto(), rule)),
      rulesMode: record.rulesMode,
      context: record.context === null ? null : Object.assign(new RuleOverrideContextDto(), record.context),
      sha256: record.sha256,
      updatedAt: record.updatedAt.toISOString(),
    });
  }
}

/**
 * One stored GitLab token, without the token: who it belongs to, when it runs out and whether it
 * still works.
 */
export class GitLabTokenSummaryDto {
  @ApiProperty({ description: 'The GitLab username the token belongs to' })
  declare username: string;
  @ApiPropertyOptional({ nullable: true, description: 'When the token expires (ISO 8601)' })
  declare expiresAt: string | null;
  @ApiProperty({ enum: ['ok', 'invalid', 'expiring'], description: 'The health of the token' })
  declare status: 'ok' | 'invalid' | 'expiring';
}

/** The write token's summary, with the flag that says whether it belongs to a bot account. */
export class GitLabWriteTokenSummaryDto extends GitLabTokenSummaryDto {
  @ApiProperty({ description: 'Whether the write token belongs to a bot account' })
  declare isBot: boolean;
}

/**
 * The GitLab connection of a repo: its numeric project id, the health of its two tokens and the
 * warnings the admin has to see. A GitHub repo, and a GitLab repo without tokens, carry none of it.
 */
export class GitLabCredentialDto {
  @ApiProperty({ description: 'The numeric GitLab project id' })
  declare projectId: number;
  @ApiProperty({ type: () => GitLabTokenSummaryDto })
  declare readToken: GitLabTokenSummaryDto;
  @ApiProperty({ type: () => GitLabWriteTokenSummaryDto })
  declare writeToken: GitLabWriteTokenSummaryDto;
  @ApiProperty({ type: [String], description: 'The warnings about this connection' })
  declare warnings: string[];
}

/** The host a repo without one lives on: GitHub's. */
const DEFAULT_REPO_HOST = 'https://github.com';

/** The GitLab connection of a repo row, projected without its secrets. */
function toGitLabCredential(credential: GitLabCredentialView, now: Date): GitLabCredentialDto {
  return Object.assign(new GitLabCredentialDto(), {
    projectId: credential.gitlabProjectId,
    readToken: Object.assign(new GitLabTokenSummaryDto(), {
      username: credential.readTokenUsername,
      expiresAt: credential.readTokenExpiresAt?.toISOString() ?? null,
      status: gitlabTokenStatus(credential.readTokenExpiresAt, credential.readTokenInvalidAt, now),
    }),
    writeToken: Object.assign(new GitLabWriteTokenSummaryDto(), {
      username: credential.writeTokenUsername,
      expiresAt: credential.writeTokenExpiresAt?.toISOString() ?? null,
      status: gitlabTokenStatus(credential.writeTokenExpiresAt, credential.writeTokenInvalidAt, now),
      isBot: credential.writeTokenIsBot,
    }),
    warnings: credential.writeTokenIsBot ? [] : ['write_token_human'],
  });
}

export class FleetRepoDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty({ enum: ['github', 'gitlab'] }) declare provider: 'github' | 'gitlab';
  @ApiProperty() declare owner: string;
  @ApiProperty() declare name: string;
  @ApiProperty({ description: 'The forge host the repo lives on' }) declare host: string;
  @ApiProperty() declare defaultBranch: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'GitHub App installation id (BigInt as string)' })
  declare githubInstallationId: string | null;
  @ApiProperty() declare createdAt: string;
  @ApiProperty() declare autoReview: boolean;
  @ApiProperty({ type: [String] }) declare autoReviewProfiles: string[];
  @ApiProperty() declare autoReviewMaxCostUsd: string;
  @ApiPropertyOptional({ nullable: true }) declare autoReviewEnabledById: string | null;
  @ApiPropertyOptional({ enum: ['USER', 'AGENT'], nullable: true }) declare autoReviewEnabledByType: 'USER' | 'AGENT' | null;
  @ApiPropertyOptional({ nullable: true }) declare autoReviewEnabledAt: string | null;
  @ApiProperty({ description: 'Allow FIX to run the check commands it detects for a base branch without nax check commands' })
  declare fixTrustDetectedChecks: boolean;
  @ApiProperty({ description: 'Allow FIX to push although the default branch is unprotected (override, default off)' })
  declare fixAllowUnprotected: boolean;
  @ApiPropertyOptional({ type: () => RuleOverrideSummaryDto, nullable: true, description: 'The repo rule override summary, when the repo has one' })
  declare ruleOverride: RuleOverrideSummaryDto | null;
  @ApiPropertyOptional({ type: () => GitLabCredentialDto, nullable: true, description: 'The GitLab connection of the repo, when it has one' })
  declare gitlab: GitLabCredentialDto | null;

  static from(r: FleetRepoRecord, now = new Date()): FleetRepoDto {
    return Object.assign(new FleetRepoDto(), {
      id: r.id, projectId: r.projectId, provider: r.provider as FleetRepoDto['provider'], owner: r.owner, name: r.name,
      host: r.host ?? DEFAULT_REPO_HOST,
      defaultBranch: r.defaultBranch, githubInstallationId: r.githubInstallationId === null ? null : r.githubInstallationId.toString(),
      createdAt: r.createdAt.toISOString(), autoReview: r.autoReview, autoReviewProfiles: r.autoReviewProfiles,
      autoReviewMaxCostUsd: Number(r.autoReviewMaxCostUsd).toFixed(4), autoReviewEnabledById: r.autoReviewEnabledById,
      autoReviewEnabledByType: r.autoReviewEnabledByType,
      autoReviewEnabledAt: r.autoReviewEnabledAt?.toISOString() ?? null,
      fixTrustDetectedChecks: r.fixTrustDetectedChecks === true,
      fixAllowUnprotected: r.fixAllowUnprotected === true,
      ruleOverride: r.ruleOverride === undefined || r.ruleOverride === null ? null : Object.assign(new RuleOverrideSummaryDto(), {
        sha256: r.ruleOverride.sha256,
        ruleFiles: r.ruleOverride.ruleFiles,
        rulesMode: r.ruleOverride.rulesMode,
        contextMode: r.ruleOverride.contextMode,
        updatedAt: r.ruleOverride.updatedAt.toISOString(),
      }),
      gitlab: r.gitlabCredential === undefined || r.gitlabCredential === null ? null : toGitLabCredential(r.gitlabCredential, now),
    });
  }
}
