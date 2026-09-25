import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsObject, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Typed body for POST /memory/extract.
 *
 * Security note (H12): the extraction handler always attributes resulting
 * memory items to the authenticated principal — there is intentionally no
 * `actorId` field here, so a caller cannot forge another agent's/user's
 * memory ownership. The remaining fields are a conservative whitelist of
 * what ExtractionService.extractFromEvent actually consumes.
 */
export class ExtractEventDto {
  @ApiProperty({ description: 'Project ID the event belongs to' })
  @IsString()
  @MinLength(1)
  projectId!: string;

  @ApiProperty({ required: false, description: 'Canonical event type (e.g. ticket_event, agent_event, decision_event)' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiProperty({ required: false, description: 'ID of the source event record' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({ description: 'Action performed in the event (e.g. status_changed)' })
  @IsString()
  action!: string;

  @ApiProperty({ description: 'Event payload consumed by the extraction rules' })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiProperty({ required: false, description: 'Ticket ID for ticket_event payloads' })
  @IsOptional()
  @IsString()
  ticketId?: string;

  @ApiProperty({ required: false, description: 'Agent ID for agent_event/decision_event payloads' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiProperty({ required: false, description: 'Decision text for decision_event payloads' })
  @IsOptional()
  @IsString()
  decision?: string;

  @ApiProperty({ required: false, description: 'ISO8601 timestamp of the event' })
  @IsOptional()
  @IsISO8601()
  timestamp?: string;
}
