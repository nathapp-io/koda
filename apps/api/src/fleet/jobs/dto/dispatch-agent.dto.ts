import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min, ValidatorConstraint, type ValidatorConstraintInterface, type ValidationArguments, Validate } from 'class-validator';
import { AGENT_MODEL_ALIAS_KEY_RE, AGENT_MODEL_ALIAS_MAX_ENTRIES, AGENT_MODEL_MAX_LENGTH, AGENT_NAME_RE, AGENT_TASK_MAX_LENGTH, AGENT_TIMEOUT_MAX_SEC, AGENT_TIMEOUT_MIN_SEC, isModelAliasTarget } from '../../common/agent-jobs';

@ValidatorConstraint({ name: 'agentModelAliases', async: false })
class AgentModelAliasesValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= AGENT_MODEL_ALIAS_MAX_ENTRIES && entries.every(([key, target]) => AGENT_MODEL_ALIAS_KEY_RE.test(key) && isModelAliasTarget(target));
  }
  defaultMessage(_args: ValidationArguments): string { return 'modelAliases is invalid'; }
}

export class DispatchAgentDto {
  @ApiProperty({ pattern: `^(?!.*\\.\\.)${AGENT_NAME_RE.source.slice(1)}`, maxLength: 128 }) @IsString() @Matches(AGENT_NAME_RE) @Matches(/^(?!.*\.\.).*$/) declare name: string;
  @ApiProperty({ minLength: 1, maxLength: AGENT_TASK_MAX_LENGTH }) @IsString() @Length(1, AGENT_TASK_MAX_LENGTH) @Matches(/\S/) declare task: string;
  @ApiPropertyOptional({ maxLength: AGENT_MODEL_MAX_LENGTH }) @IsOptional() @IsString() @Length(1, AGENT_MODEL_MAX_LENGTH) @Matches(/\S/) model?: string;
  @ApiPropertyOptional({ type: Object, maxProperties: AGENT_MODEL_ALIAS_MAX_ENTRIES }) @IsOptional() @IsObject() @Validate(AgentModelAliasesValidator) modelAliases?: Record<string, string>;
  @ApiPropertyOptional({ minimum: AGENT_TIMEOUT_MIN_SEC, maximum: AGENT_TIMEOUT_MAX_SEC }) @IsOptional() @IsInt() @Min(AGENT_TIMEOUT_MIN_SEC) @Max(AGENT_TIMEOUT_MAX_SEC) timeoutSec?: number;
}
