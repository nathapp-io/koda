import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LOG_STREAMS } from '../domain/fleet-job-log.domain';
import { LOG_LEVELS } from '../log-entry';

/** Spec §3.1: one stored stream of one attempt. */
export class FleetJobLogStreamDto {
  @ApiProperty({ enum: LOG_STREAMS }) declare stream: string;
  @ApiProperty({ description: 'Bytes stored (at most FLEET_LOG_MAX_BYTES)' }) declare sizeBytes: number;
  @ApiProperty({ description: 'final=1 accepted, or filled from the bundle' }) declare complete: boolean;
  @ApiProperty({ description: 'Cut at FLEET_LOG_MAX_BYTES; the full text is in the bundle' }) declare truncated: boolean;
  @ApiProperty({ enum: ['stream', 'bundle'] }) declare source: string;
  @ApiProperty({ description: 'Deleted by retention (spec §5); reads answer 410' }) declare expired: boolean;
  @ApiProperty() declare updatedAt: string;
}

export class FleetJobLogAttemptDto {
  @ApiProperty() declare leaseEpoch: number;
  @ApiProperty({ description: 'The attempt has only sampled `log` timeline events (a v1/v2 runner)' }) declare legacySampled: boolean;
  @ApiProperty({ type: [FleetJobLogStreamDto] }) declare streams: FleetJobLogStreamDto[];
}

export class FleetJobLogListDto {
  @ApiProperty({ type: [FleetJobLogAttemptDto], description: 'Latest attempt first' }) declare attempts: FleetJobLogAttemptDto[];
}

/** Spec §3.3 / D339: a parsed nax LogEntry, an unparsed run line, or a stdout/stderr line. */
export class FleetJobLogEntryDto {
  @ApiProperty({ description: 'Byte offset of the line start' }) declare offset: number;
  @ApiProperty({ description: 'Bytes of the line, including its newline' }) declare length: number;
  @ApiPropertyOptional({ description: 'Run stream: the line is not a nax LogEntry' }) declare unparsed?: boolean;
  @ApiPropertyOptional({ description: 'The entry is a piece of a line (overlong, or read from mid-line)' }) declare truncatedLine?: boolean;
  @ApiPropertyOptional({ description: 'The raw line without its newline (unparsed, stdout, stderr)' }) declare text?: string;
  @ApiPropertyOptional() declare timestamp?: string;
  @ApiPropertyOptional({ enum: LOG_LEVELS }) declare level?: string;
  @ApiPropertyOptional() declare stage?: string;
  @ApiPropertyOptional() declare storyId?: string;
  @ApiPropertyOptional() declare sessionRole?: string;
  @ApiPropertyOptional() declare message?: string;
  @ApiPropertyOptional({ type: Object, description: 'LogEntry.data as nax wrote it' }) declare data?: unknown;
}

export class FleetJobLogEntriesDto {
  @ApiProperty({ type: [FleetJobLogEntryDto], description: 'Ascending by offset in both directions' }) declare entries: FleetJobLogEntryDto[];
  @ApiProperty({ description: 'Cursor for the next request in the same direction' }) declare nextCursor: number;
  @ApiProperty() declare scannedFrom: number;
  @ApiProperty() declare scannedTo: number;
  @ApiProperty({ description: 'Forward: no complete line after nextCursor. Backward: nextCursor is 0' }) declare atEnd: boolean;
  @ApiProperty({ description: 'Bytes stored now' }) declare size: number;
  @ApiProperty() declare complete: boolean;
  @ApiProperty() declare truncated: boolean;
}
