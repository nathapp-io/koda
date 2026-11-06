import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min, ValidatorConstraint, type ValidatorConstraintInterface, type ValidationArguments, Validate } from 'class-validator';
import { AGENT_MODEL_ALIAS_KEY_RE, AGENT_MODEL_ALIAS_MAX_ENTRIES, AGENT_MODEL_MAX_LENGTH, AGENT_NAME_RE, AGENT_TASK_MAX_LENGTH, AGENT_TIMEOUT_MAX_SEC, AGENT_TIMEOUT_MIN_SEC, hasNul, isModelAliasTarget } from '../../common/agent-jobs';

@ValidatorConstraint({ name: 'agentModelAliases', async: false })
class AgentModelAliasesValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= AGENT_MODEL_ALIAS_MAX_ENTRIES && entries.every(([key, target]) => AGENT_MODEL_ALIAS_KEY_RE.test(key) && isModelAliasTarget(target));
  }
  defaultMessage(_args: ValidationArguments): string { return 'modelAliases is invalid'; }
}

/**
 * The dispatch input is stored in a jsonb column, and PostgreSQL refuses U+0000 in one (SQLSTATE 22P05, "unsupported
 * Unicode escape sequence"): without this the route would answer 500 at the insert instead of 400 here. Only strings
 * are judged — `@IsString` owns the type error.
 */
@ValidatorConstraint({ name: 'agentText', async: false })
class AgentTextValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value !== 'string' || !hasNul(value);
  }
  defaultMessage(_args: ValidationArguments): string { return 'text must not contain U+0000'; }
}

export class DispatchAgentDto {
  @ApiProperty({ pattern: `^(?!.*\\.\\.)${AGENT_NAME_RE.source.slice(1)}`, maxLength: 128 }) @IsString() @Matches(AGENT_NAME_RE) @Matches(/^(?!.*\.\.).*$/) declare name: string;
  @ApiProperty({ minLength: 1, maxLength: AGENT_TASK_MAX_LENGTH, description: 'The task text. U+0000 is refused: the job column is jsonb and PostgreSQL cannot store it.' })
  @IsString() @Length(1, AGENT_TASK_MAX_LENGTH) @Matches(/\S/) @Validate(AgentTextValidator) declare task: string;
  @ApiPropertyOptional({ maxLength: AGENT_MODEL_MAX_LENGTH, pattern: '^\\S+$', description: 'U+0000 is refused, as for the task.' })
  @IsOptional() @IsString() @Length(1, AGENT_MODEL_MAX_LENGTH) @Matches(/^\S+$/) @Validate(AgentTextValidator) model?: string;
  @ApiPropertyOptional({ type: Object, maxProperties: AGENT_MODEL_ALIAS_MAX_ENTRIES }) @IsOptional() @IsObject() @Validate(AgentModelAliasesValidator) modelAliases?: Record<string, string>;
  @ApiPropertyOptional({ minimum: AGENT_TIMEOUT_MIN_SEC, maximum: AGENT_TIMEOUT_MAX_SEC }) @IsOptional() @IsInt() @Min(AGENT_TIMEOUT_MIN_SEC) @Max(AGENT_TIMEOUT_MAX_SEC) timeoutSec?: number;
}
