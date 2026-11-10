import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FleetRepoRecord, FleetRepoRuleOverrideRecord } from '../domain/fleet-repo.domain';

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

export class FleetRepoDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare projectId: string;
  @ApiProperty({ enum: ['github', 'gitlab'] }) declare provider: 'github' | 'gitlab';
  @ApiProperty() declare owner: string;
  @ApiProperty() declare name: string;
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

  static from(r: FleetRepoRecord): FleetRepoDto {
    return Object.assign(new FleetRepoDto(), {
      id: r.id, projectId: r.projectId, provider: r.provider as FleetRepoDto['provider'], owner: r.owner, name: r.name,
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
    });
  }
}
