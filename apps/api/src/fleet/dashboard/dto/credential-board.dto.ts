import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import type {
  CredentialBoard, CredentialBoardRunner, CredentialCell, CredentialCellKind, CredentialCellState, ProfileCell,
} from '../credential-board';
import { MISFIT_REASONS } from '../dashboard.types';
import type { MisfitReason } from '../../jobs/placement-rules';
import type { NaxProtocol, ProfileNeeds } from '../../common/protocol';
import type { ProviderKeySummary } from '../../provider-credentials/provider-credential.domain';

const STATES: readonly CredentialCellState[] = ['ok', 'expiring', 'expired', 'unavailable', 'missing'];
const KINDS: readonly CredentialCellKind[] = ['api-key', 'oauth', 'exec', 'ambient', 'none'];

export class CredentialBoardRunnerDto implements CredentialBoardRunner {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: 'Synced within FLEET_RUNNER_OFFLINE_SEC' }) online: boolean;
  @ApiProperty({ description: 'False when the stored capabilities do not parse; the runner then has no cells' }) readable: boolean;
  @ApiProperty({ description: 'The runner serves koda provider keys through nax\'s exec helper (providerVault capability)' })
  providerVault: boolean;
}

/**
 * One active GLOBAL key, as the board's koda column shows it (C10 US-007). Metadata only: a field
 * for the key or its ciphertext is deliberately absent, so "write-only after save" is the shape.
 */
export class KodaKeyDto implements ProviderKeySummary {
  @ApiProperty() providerId: string;
  @ApiProperty({ description: 'The credential\'s display name' }) name: string;
  @ApiProperty({ description: 'Last four characters of the key, for display only' }) last4: string;
  @ApiProperty({ format: 'date-time', description: 'ISO 8601: when the key or its name last changed' }) updatedAt: string;
}

export class CredentialCellDto implements CredentialCell {
  @ApiProperty({ enum: STATES }) state: CredentialCellState;
  @ApiProperty({ enum: KINDS }) kind: CredentialCellKind;
  @ApiPropertyOptional({ format: 'date-time' }) expires?: string;
}

export class CredentialProviderRowDto {
  @ApiProperty() providerId: string;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: getSchemaPath(CredentialCellDto) }, description: 'Keyed by runner id' })
  cells: Record<string, CredentialCell>;
}

export class ProfileNeedsDto implements Omit<ProfileNeeds, 'interaction'> {
  @ApiProperty({ enum: ['acp', 'native'] }) protocol: NaxProtocol;
  @ApiProperty({ type: [String] }) providers: string[];
  @ApiProperty() sandbox: boolean;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) interaction?: ProfileNeeds['interaction'];
}

export class ProfileCellDto implements ProfileCell {
  @ApiProperty() present: boolean;
  @ApiPropertyOptional({ type: ProfileNeedsDto }) needs?: ProfileNeeds;
  @ApiPropertyOptional({ enum: MISFIT_REASONS }) misfit?: MisfitReason;
}

export class ProfileRowDto {
  @ApiProperty() name: string;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: getSchemaPath(ProfileCellDto) }, description: 'Keyed by runner id' })
  runners: Record<string, ProfileCell>;
}

export class CredentialBoardDto implements CredentialBoard {
  @ApiProperty({ format: 'date-time' }) generatedAt: string;
  @ApiProperty({ description: 'FLEET_CREDENTIAL_EXPIRY_WARN_DAYS' }) warnDays: number;
  @ApiProperty({ type: [KodaKeyDto], description: 'Active GLOBAL keys koda holds; empty when the vault is off' })
  kodaKeys: KodaKeyDto[];
  @ApiProperty({ type: [CredentialBoardRunnerDto] }) runners: CredentialBoardRunner[];
  @ApiProperty({ type: [CredentialProviderRowDto] }) providers: CredentialProviderRowDto[];
  @ApiProperty({ type: [ProfileRowDto] }) profiles: ProfileRowDto[];
}
